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
  usage: number;
  rate: number;
  peakRate?: number;
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
      models: Record<string, { usage: number; rate: number; peakRate?: number }>;
    }
  > = {};
  for (const p of providers) {
    const f = readModelsFile(p);
    const models: Record<string, { usage: number; rate: number; peakRate?: number }> = {};
    for (const [id, m] of Object.entries(f.models ?? {})) {
      // 只暴露计算百分比所需字段
      models[id] = { usage: m.usage ?? 0, rate: m.rate ?? 1 };
      if (m.peakRate !== undefined) models[id].peakRate = m.peakRate;
    }
    tables[p] = {
      monthlyQuotaUsd: f.monthly_quota_usd,
      payAsYouGo: f.payAsYouGo,
      unit: f.unit,
      models,
    };
  }
  return NextResponse.json({ ok: true, tables });
}
