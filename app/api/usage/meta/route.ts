import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const dynamic = "force-dynamic";

const PI_DIR = join(homedir(), ".pi", "agent");
const MODELS_DIR = join(PI_DIR, "usage-tracker", "models");
const LEDGER_PATH = join(PI_DIR, "usage-log.jsonl");

/**
 * 聊天页消息行「月额度百分比」的数据源：
 * 返回每个 provider 的模型表（usage/rate/peakRate）+ 渠道月额度，
 * 供前端按 message.provider/model 计算 pct = costUsd × rate / 月额度 × 100。
 *
 * 与 /api/usage 读同一份 usage-tracker/models/{provider}.json，
 * 保证聊天页与 /usage 看板、usage-tracker 记账三方一致（见 QUOTA-SWITCHING.md）。
 *
 * 注意：模型文件名做了安全化（"Command Code" → "Command_Code"），无法从文件名
 * 还原真实渠道名；因此 provider 列表以账本 usage-log.jsonl 里出现的真实名为准
 * （与 /api/usage 的 providers 一致），再按安全化规则读对应文件。
 */

interface ModelMeta {
  in: number;
  out: number;
  cr: number;
  cw: number;
  /** 模型月额度（$）—— 唯一真源，倍率由它派生 */
  usage: number;
  /** @deprecated 手写倍率（已由 usage 派生，此处仅兼容旧数据） */
  rate?: number;
  /** @deprecated 绝对高峰倍率，改用 peakMultiplier */
  peakRate?: number;
  /** 高峰倍率乘数（deepseek-v4 系列 = 2） */
  peakMultiplier?: number;
}

/**
 * 基础倍率 = 渠道月池 / 模型月额度。
 * 与 lib/opencode-quota.ts 的 deriveBaseRate、usage-tracker 的记账口径三方一致。
 */
function deriveBaseRate(
  monthlyQuotaUsd: number | undefined,
  usage: number | undefined,
): number {
  if (!usage || usage <= 0 || !monthlyQuotaUsd || monthlyQuotaUsd <= 0) return 0;
  return monthlyQuotaUsd / usage;
}
/**
 * 高峰倍率乘数：优先 peakMultiplier，旧数据回退 peakRate/rate 的比值。
 * 比值是定价方案级别的事实，不随 usage 变动而失效。
 */
function peakMultiplierOf(m: ModelMeta): number {
  if (typeof m.peakMultiplier === "number" && m.peakMultiplier > 1) {
    return m.peakMultiplier;
  }
  if (
    typeof m.peakRate === "number" &&
    typeof m.rate === "number" &&
    m.rate > 0 &&
    m.peakRate > m.rate
  ) {
    return m.peakRate / m.rate;
  }
  return 1;
}

function modelsPath(provider: string): string {
  return join(MODELS_DIR, `${provider.replace(/[^\w.-]/g, "_")}.json`);
}

function readModelsFile(provider: string): {
  monthly_quota_usd?: number;
  payAsYouGo?: boolean;
  unit?: "usd" | "count";
  models: Record<string, ModelMeta>;
} {
  try {
    return JSON.parse(readFileSync(modelsPath(provider), "utf-8")) as {
      monthly_quota_usd?: number;
      payAsYouGo?: boolean;
      unit?: "usd" | "count";
      models: Record<string, ModelMeta>;
    };
  } catch {
    return { models: {} };
  }
}

/** 账本中出现的真实渠道名（与 /api/usage providers 一致）。 */
function listLedgerProviders(): string[] {
  try {
    if (!existsSync(LEDGER_PATH)) return [];
    const set = new Set<string>();
    for (const line of readFileSync(LEDGER_PATH, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { provider?: string };
        if (e.provider) set.add(e.provider);
      } catch {
        // skip corrupt lines
      }
    }
    return Array.from(set);
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider");
  const providers = provider ? [provider] : listLedgerProviders();
  const tables: Record<
    string,
    {
      monthlyQuotaUsd?: number;
      payAsYouGo?: boolean;
      unit?: "usd" | "count";
      models: Record<
        string,
        { usage: number; rate: number; peakRate?: number; peakMultiplier?: number }
      >;
    }
  > = {};
  for (const p of providers) {
    const f = readModelsFile(p);
    // 渠道月池（缺省用 $60），倍率统一由它派生
    const monthly = f.monthly_quota_usd;
    const models: Record<
      string,
      { usage: number; rate: number; peakRate?: number; peakMultiplier?: number }
    > = {};
    for (const [id, m] of Object.entries(f.models ?? {})) {
      // 只暴露计算百分比所需字段。
      // rate / peakRate 均为**派生值**（而非表里的手写值），因此即使客户端
      // 仍是旧版（只读 rate / peakRate）也能得到正确百分比；
      // 新版客户端则直接用 usage + peakMultiplier 自行派生。
      const usage = m.usage ?? 0;
      const base = deriveBaseRate(monthly, usage);
      const mult = peakMultiplierOf(m);
      const derived = base > 0 ? base : (m.rate ?? 1);
      models[id] = { usage, rate: derived };
      if (mult > 1) {
        models[id].peakMultiplier = mult;
        models[id].peakRate = derived * mult;
      }
    }
    tables[p] = {
      monthlyQuotaUsd: monthly,
      payAsYouGo: f.payAsYouGo,
      unit: f.unit,
      models,
    };
  }
  return NextResponse.json({ ok: true, tables });
}
