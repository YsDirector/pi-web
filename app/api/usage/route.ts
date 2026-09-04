import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const dynamic = "force-dynamic";

const PI_DIR = join(homedir(), ".pi", "agent");
const LEDGER_PATH = join(PI_DIR, "usage-log.jsonl");
const STATE_PATH = join(PI_DIR, "usage-state.json");
const MODELS_PATH = join(PI_DIR, "usage-tracker", "opencode-go-models.json");
const MONTHLY_QUOTA_USD = 60.0;

interface ModelPrice {
  in: number;
  out: number;
  cr: number;
  cw: number;
  usage: number;
  rate: number;
  peakRate?: number;
}

function loadModels(): Record<string, ModelPrice> {
  try {
    const raw = JSON.parse(readFileSync(MODELS_PATH, "utf-8")) as {
      models?: Record<string, ModelPrice>;
    };
    return raw.models ?? {};
  } catch {
    return {};
  }
}

function isPeakHours(ts: number = Date.now()): boolean {
  const d = new Date(ts + 8 * 3600 * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (
    (minutes >= 9 * 60 && minutes < 12 * 60) ||
    (minutes >= 14 * 60 && minutes < 18 * 60)
  );
}

interface LedgerEntry {
  ts: number;
  iso: string;
  source: "pi" | "vision";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  rate: number;
  quotaPct: number;
}

interface UsageState {
  enabled: boolean;
  periodStartTs: number;
  baselineQuotaPct: number;
}

function loadLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(LEDGER_PATH, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return entries;
}

function loadState(): UsageState {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<UsageState>;
    return {
      enabled: s.enabled !== false,
      periodStartTs: s.periodStartTs ?? 0,
      baselineQuotaPct: s.baselineQuotaPct ?? 0,
    };
  } catch {
    return { enabled: true, periodStartTs: 0, baselineQuotaPct: 0 };
  }
}

function summarize(entries: LedgerEntry[], startTs: number) {
  const total = { costUsd: 0, quotaPct: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, count: 0 };
  const byModel: Record<string, typeof total & { rate?: number; peakRate?: number }> = {};
  const models = loadModels();
  for (const e of entries) {
    if (e.ts < startTs) continue;
    total.costUsd += e.costUsd;
    total.quotaPct += e.quotaPct;
    total.inputTokens += e.inputTokens;
    total.outputTokens += e.outputTokens;
    total.totalTokens += e.totalTokens;
    total.count += 1;
    byModel[e.model] ??= { costUsd: 0, quotaPct: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, count: 0 };
    const m = byModel[e.model];
    m.costUsd += e.costUsd;
    m.quotaPct += e.quotaPct;
    m.inputTokens += e.inputTokens;
    m.outputTokens += e.outputTokens;
    m.totalTokens += e.totalTokens;
    m.count += 1;
  }
  // 附加模型元信息
  for (const [mid, agg] of Object.entries(byModel)) {
    const meta = models[mid];
    if (meta) {
      agg.rate = isPeakHours() && meta.peakRate ? meta.peakRate : meta.rate;
      agg.peakRate = meta.peakRate;
      (agg as Record<string, unknown>).modelUsage = meta.usage;
    }
  }
  return { total, byModel };
}

export async function GET() {
  const models = loadModels();
  const state = loadState();
  const entries = loadLedger();
  const { total, byModel } = summarize(entries, state.periodStartTs);
  const deltaPct = total.quotaPct;
  const totalPct = state.baselineQuotaPct + deltaPct;

  return NextResponse.json({
    ok: true,
    state: {
      enabled: state.enabled,
      periodStartTs: state.periodStartTs,
      periodStartIso: state.periodStartTs
        ? new Date(state.periodStartTs).toISOString()
        : null,
      baselineQuotaPct: state.baselineQuotaPct,
    },
    quota: {
      monthlyQuotaUsd: MONTHLY_QUOTA_USD,
      baseQuotaUsd: models["deepseek-v4-flash"]?.usage ?? 30,
      totalPct,
      deltaPct,
      costUsd: total.costUsd,
      count: total.count,
      tokens: {
        input: total.inputTokens,
        output: total.outputTokens,
        total: total.totalTokens,
      },
    },
    byModel: Object.entries(byModel).map(([model, agg]) => ({
      model,
      count: agg.count,
      costUsd: agg.costUsd,
      quotaPct: agg.quotaPct,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      rate: agg.rate,
      peakRate: agg.peakRate,
      modelUsageUsd: (agg as { modelUsage?: number }).modelUsage,
    })),
    models: Object.entries(models).map(([id, m]) => ({
      id,
      name: id,
      usageUsd: m.usage,
      rate: m.rate,
      peakRate: m.peakRate,
    })),
    peakNow: isPeakHours(),
    ledger: entries.slice(-50).reverse(),
  });
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      baselineQuotaPct?: number;
      reset?: boolean;
      enabled?: boolean;
    };
    const state = loadState();
    if (typeof body.baselineQuotaPct === "number") {
      if (body.baselineQuotaPct < 0) {
        return NextResponse.json({ ok: false, error: "baselineQuotaPct must be >= 0" }, { status: 400 });
      }
      state.baselineQuotaPct = body.baselineQuotaPct;
    }
    if (body.reset) {
      state.periodStartTs = Date.now();
      state.baselineQuotaPct = 0;
    }
    if (typeof body.enabled === "boolean") {
      state.enabled = body.enabled;
    }
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}