import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const dynamic = "force-dynamic";

const PI_DIR = join(homedir(), ".pi", "agent");
const LEDGER_PATH = join(PI_DIR, "usage-log.jsonl");
const STATE_PATH = join(PI_DIR, "usage-state.json");
const MODELS_DIR = join(PI_DIR, "usage-tracker", "models");
const LEGACY_MODELS_PATH = join(PI_DIR, "usage-tracker", "opencode-go-models.json");
const MODELS_STORE_PATH = join(PI_DIR, "models-store.json");
const MONTHLY_QUOTA_USD = 60.0;

/** 模型表按 provider 分文件：usage-tracker/models/{provider}.json */
function modelsPath(provider: string): string {
  return join(MODELS_DIR, `${provider.replace(/[^\w.-]/g, "_")}.json`);
}

/** 启动/懒加载时迁移旧单文件表 → 按 provider 分文件 */
function ensureModelsMigration(): void {
  try {
    if (!existsSync(LEGACY_MODELS_PATH)) return;
    const legacy = JSON.parse(readFileSync(LEGACY_MODELS_PATH, "utf-8")) as {
      monthly_quota_usd?: number;
      models?: Record<string, ModelPrice>;
    };
    const models = legacy.models ?? {};
    if (Object.keys(models).length === 0) return;
    const target = modelsPath("opencode-go");
    if (!existsSync(target)) {
      writeFileSync(target, JSON.stringify(legacy, null, 2), "utf-8");
    }
  } catch {
    // 迁移失败不阻塞
  }
}

interface StoreModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface StoreModelMeta {
  in: number;
  out: number;
  cr: number;
  cw: number;
  name?: string;
}

/**
 * 从 ~/.pi/agent/models-store.json 读取各 provider 的模型价格
 * （pi 自动同步的官方目录数据，与 pi 侧定价一致）。
 * 返回 { provider -> { modelId -> { in,out,cr,cw,name } } }。
 */
function loadStorePrices(): Record<string, Record<string, StoreModelMeta>> {
  try {
    const raw = JSON.parse(readFileSync(MODELS_STORE_PATH, "utf-8")) as Record<
      string,
      { models?: Array<{ id?: string; name?: string; cost?: StoreModelCost }> }
    >;
    const out: Record<string, Record<string, StoreModelMeta>> = {};
    for (const [provider, entry] of Object.entries(raw)) {
      const list = entry.models ?? [];
      const map: Record<string, StoreModelMeta> = {};
      for (const m of list) {
        if (!m.id) continue;
        const c = m.cost ?? {};
        map[m.id] = {
          in: c.input ?? 0,
          out: c.output ?? 0,
          cr: c.cacheRead ?? 0,
          cw: c.cacheWrite ?? 0,
          name: m.name,
        };
      }
      out[provider] = map;
    }
    return out;
  } catch {
    return {};
  }
}

interface ModelFile {
  monthly_quota_usd?: number;
  payAsYouGo?: boolean; // 按量计费渠道：无月池，不显示百分比
  unit?: "usd" | "count"; // 计费单位：usd=美元额度，count=按调用次数
  models: Record<string, ModelPrice>;
}

function readModelsFile(provider: string): ModelFile {
  try {
    return JSON.parse(readFileSync(modelsPath(provider), "utf-8")) as ModelFile;
  } catch {
    return { monthly_quota_usd: MONTHLY_QUOTA_USD, models: {} };
  }
}

function writeModelsFile(provider: string, data: ModelFile): void {
  writeFileSync(join(MODELS_DIR, `${provider.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify(data, null, 2), "utf-8");
}

/**
 * 同步价格：把 models-store.json 的最新价格 merge 进 usage-tracker 模型表。
 * 手动字段（usage/rate/peakRate）保留；in/out/cr/cw 以 pi 目录为准。
 * 返回 updated/added/missing 及同步后的完整模型表。
 */
function syncPricesFromStore(provider: string): {
  updated: string[];
  added: string[];
  missing: string[];
  models: Record<string, ModelPrice>;
} {
  const store = loadStorePrices();
  const storeModels = store[provider] ?? {};
  const data = readModelsFile(provider);
  const current = data.models ?? {};
  const updated: string[] = [];
  const added: string[] = [];
  const missing: string[] = [];
  const next: Record<string, ModelPrice> = {};
  for (const [id, price] of Object.entries(storeModels)) {
    const existing = current[id];
    if (existing) {
      next[id] = { ...existing, in: price.in, out: price.out, cr: price.cr, cw: price.cw };
      if (
        existing.in !== price.in ||
        existing.out !== price.out ||
        existing.cr !== price.cr ||
        existing.cw !== price.cw
      ) {
        updated.push(id);
      }
    } else {
      next[id] = { in: price.in, out: price.out, cr: price.cr, cw: price.cw, usage: 0, rate: 1 };
      added.push(id);
    }
  }
  // 保留表里但 pi 目录已没有的模型（不删，标记 missing）
  for (const id of Object.keys(current)) {
    if (!(id in storeModels)) {
      next[id] = current[id];
      missing.push(id);
    }
  }
  writeModelsFile(provider, { ...data, models: next });
  return { updated, added, missing, models: next };
}

/** 更新单个模型的手动字段（usage/rate/peakRate）；返回更新后的完整模型表 */
function updateModelMeta(
  provider: string,
  modelId: string,
  meta: { usage?: number; rate?: number; peakRate?: number | null },
): Record<string, ModelPrice> {
  const data = readModelsFile(provider);
  const models = data.models ?? {};
  if (!models[modelId]) models[modelId] = { in: 0, out: 0, cr: 0, cw: 0, usage: 0, rate: 1 };
  const m = models[modelId];
  if (typeof meta.usage === "number") m.usage = meta.usage;
  if (typeof meta.rate === "number") m.rate = meta.rate;
  if (meta.peakRate !== undefined) {
    if (meta.peakRate === null) delete m.peakRate;
    else m.peakRate = meta.peakRate;
  }
  writeModelsFile(provider, { ...data, models });
  return models;
}

interface ModelPrice {
  in: number;
  out: number;
  cr: number;
  cw: number;
  usage: number;
  rate: number;
  peakRate?: number;
}

function loadModels(provider?: string): Record<string, ModelPrice> {
  // provider 缺省 = 合并全部已分文件的模型表（古老接口兼容）
  const providers = provider ? [provider] : listModelProviders();
  const merged: Record<string, ModelPrice> = {};
  for (const p of providers) {
    try {
      const raw = JSON.parse(readFileSync(modelsPath(p), "utf-8")) as {
        models?: Record<string, ModelPrice>;
      };
      Object.assign(merged, raw.models ?? {});
    } catch {
      // skip missing
    }
  }
  return merged;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 列出已存在的模型表 provider */
function listModelProviders(): string[] {
  try {
    if (!existsSync(MODELS_DIR)) return [];
    return readdirSyncSafe(MODELS_DIR)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.replace(/\.json$/, ""));
  } catch {
    return [];
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
  provider?: string;
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
  /** 各渠道基线：key=provider, value=账本开始前已用百分比 */
  baselines: Record<string, number>;
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
    const s = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<UsageState> & {
      baselineQuotaPct?: number;
    };
    const baselines: Record<string, number> = { ...(s.baselines ?? {}) };
    // 旧格式迁移：单值 baselineQuotaPct → opencode-go
    if (typeof s.baselineQuotaPct === "number" && s.baselineQuotaPct > 0 && !("opencode-go" in baselines)) {
      baselines["opencode-go"] = s.baselineQuotaPct;
    }
    return {
      enabled: s.enabled !== false,
      periodStartTs: s.periodStartTs ?? 0,
      baselines,
    };
  } catch {
    return { enabled: true, periodStartTs: 0, baselines: {} };
  }
}

function summarize(entries: LedgerEntry[], startTs: number) {
  const total = { costUsd: 0, quotaPct: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, count: 0 };
  // 按 provider:model 分组，避免不同渠道同 ID 模型混淆
  const byModel: Record<string, typeof total & { rate?: number; peakRate?: number; provider?: string; model?: string }> = {};
  const modelsCache = new Map<string, Record<string, ModelPrice>>();
  const modelFor = (provider: string, model: string) => {
    if (!modelsCache.has(provider)) modelsCache.set(provider, loadModels(provider));
    return modelsCache.get(provider)?.[model];
  };
  for (const e of entries) {
    if (e.ts < startTs) continue;
    total.costUsd += e.costUsd;
    total.quotaPct += e.quotaPct;
    total.inputTokens += e.inputTokens;
    total.outputTokens += e.outputTokens;
    total.totalTokens += e.totalTokens;
    total.count += 1;
    const prov = (e as LedgerEntry & { provider?: string }).provider ?? "unknown";
    const key = `${prov}:${e.model}`;
    byModel[key] ??= { costUsd: 0, quotaPct: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, count: 0 };
    const m = byModel[key];
    m.costUsd += e.costUsd;
    m.quotaPct += e.quotaPct;
    m.inputTokens += e.inputTokens;
    m.outputTokens += e.outputTokens;
    m.totalTokens += e.totalTokens;
    m.count += 1;
  }
  // 附加模型元信息（按 provider 查对应档）
  for (const [key, agg] of Object.entries(byModel)) {
    const [prov, modelId] = key.split(":");
    const meta = modelFor(prov, modelId);
    agg.provider = prov;
    agg.model = modelId;
    if (meta) {
      agg.rate = isPeakHours() && meta.peakRate ? meta.peakRate : meta.rate;
      agg.peakRate = meta.peakRate;
      (agg as Record<string, unknown>).modelUsage = meta.usage;
    }
  }
  return { total, byModel };
}

export async function GET(req: Request) {
  ensureModelsMigration();
  const { searchParams } = new URL(req.url);
  const providerParam = searchParams.get("provider");
  const models = loadModels();
  const state = loadState();
  const allEntries = loadLedger();
  // 渠道过滤：provider 精确匹配或为空（全部）
  const entries = providerParam
    ? allEntries.filter((e) => (e as LedgerEntry & { provider?: string }).provider === providerParam)
    : allEntries;
  const { total, byModel } = summarize(entries, state.periodStartTs);
  const deltaPct = total.quotaPct;
  // 基线按渠道；渠道类型：payg=按量美元、count=按调用次数、默认=订阅月池
  const activeProvider = providerParam;
  const providerMeta = activeProvider ? readModelsFile(activeProvider) : null;
  const payAsYouGo = activeProvider ? providerMeta?.payAsYouGo === true : false;
  const unit = activeProvider ? (providerMeta?.unit ?? "usd") : "usd";
  const baseline = activeProvider ? (state.baselines[activeProvider] ?? 0) : 0;
  // 百分比计算：
  //   usd：totalPct = 基线 + deltaPct（delta 按美元倍率折算）
  //   count：totalPct = (总调用次数 / 渠道总额度-次) * 100，无基线
  //   payg：无百分比（只看成本）
  const totalPct = unit === "count"
    ? (total.count > 0 && (providerMeta?.monthly_quota_usd ?? 0) > 0
        ? (total.count / (providerMeta?.monthly_quota_usd ?? 0)) * 100
        : null)
    : payAsYouGo
      ? null
      : baseline + deltaPct;


  // 渠道列表（账本中出现的 provider + 来源）
  const providers = Array.from(
    new Map(
      allEntries.map((e) => {
        const prov = (e as LedgerEntry & { provider?: string }).provider ?? "unknown";
        return [prov, prov];
      }),
    ).keys(),
  );

  // 每日 × 渠道聚合（北京时间日期），图表按渠道堆叠显示
  interface DailyProvider {
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    quotaPct: number;
    count: number;
  }
  const dailyMap = new Map<string, { date: string; byProvider: DailyProvider[] }>();
  for (const e of entries) {
    const d = new Date(e.ts + 8 * 3600 * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const prov = (e as LedgerEntry & { provider?: string }).provider ?? "unknown";
    let day = dailyMap.get(key);
    if (!day) {
      day = { date: key, byProvider: [] };
      dailyMap.set(key, day);
    }
    let agg = day.byProvider.find((x) => x.provider === prov);
    if (!agg) {
      agg = { provider: prov, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, quotaPct: 0, count: 0 };
      day.byProvider.push(agg);
    }
    agg.inputTokens += e.inputTokens;
    agg.outputTokens += e.outputTokens;
    agg.cacheReadTokens += e.cacheReadTokens;
    agg.cacheWriteTokens += e.cacheWriteTokens;
    agg.totalTokens += e.totalTokens;
    agg.costUsd += e.costUsd;
    agg.quotaPct += e.quotaPct;
    agg.count += 1;
  }
  const daily = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      ...d,
      byProvider: d.byProvider.sort((a, b) => a.provider.localeCompare(b.provider)),
      totalTokens: d.byProvider.reduce((s, x) => s + x.totalTokens, 0),
      costUsd: d.byProvider.reduce((s, x) => s + x.costUsd, 0),
      quotaPct: d.byProvider.reduce((s, x) => s + x.quotaPct, 0),
    }));

  return NextResponse.json({
    ok: true,
    providers,
    provider: providerParam ?? null,
    state: {
      enabled: state.enabled,
      periodStartTs: state.periodStartTs,
      periodStartIso: state.periodStartTs
        ? new Date(state.periodStartTs).toISOString()
        : null,
      baselines: state.baselines,
      baselineQuotaPct: state.baselines[activeProvider ?? "opencode-go"] ?? 0,
    },
    quota: {
      monthlyQuotaUsd: activeProvider ? (providerMeta?.monthly_quota_usd ?? MONTHLY_QUOTA_USD) : MONTHLY_QUOTA_USD,
      payAsYouGo,
      unit,
      countUsed: total.count,
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
    daily,
    byModel: Object.entries(byModel).map(([key, agg]) => ({
      model: (agg as { model?: string }).model ?? key,
      provider: (agg as { provider?: string }).provider,
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
    models: Object.entries(providerParam ? loadModels(providerParam) : loadModels()).map(([id, m]) => ({
      id,
      name: id,
      provider: providerParam ?? null,
      usageUsd: m.usage,
      rate: m.rate,
      peakRate: m.peakRate,
      inPrice: m.in,
      outPrice: m.out,
      crPrice: m.cr,
      cwPrice: m.cw,
    })),
    storePrices: (providerParam ? { [providerParam]: loadStorePrices()[providerParam] ?? {} } : loadStorePrices()),
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
      syncProvider?: string;
      updateProviderConfig?: { provider?: string; monthlyQuotaUsd?: number; payAsYouGo?: boolean; unit?: "usd" | "count" };
      updateModel?: { provider?: string; modelId?: string; usage?: number; rate?: number; peakRate?: number | null };
    };
    const state = loadState();
    const patchProvider = body.syncProvider
      ?? body.updateProviderConfig?.provider
      ?? body.updateModel?.provider
      ?? "opencode-go";
    if (typeof body.baselineQuotaPct === "number") {
      if (body.baselineQuotaPct < 0) {
        return NextResponse.json({ ok: false, error: "baselineQuotaPct must be >= 0" }, { status: 400 });
      }
      state.baselines[patchProvider] = body.baselineQuotaPct;
    }
    if (body.reset) {
      state.periodStartTs = Date.now();
      state.baselines = {};
    }
    if (typeof body.enabled === "boolean") {
      state.enabled = body.enabled;
    }
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");

    // 更新渠道级配置（总额度 / 按量计费标记）
    if (body.updateProviderConfig) {
      const pf = body.updateProviderConfig.provider ?? patchProvider;
      const data = readModelsFile(pf);
      if (typeof body.updateProviderConfig.monthlyQuotaUsd === "number") {
        data.monthly_quota_usd = body.updateProviderConfig.monthlyQuotaUsd;
      }
      if (typeof body.updateProviderConfig.payAsYouGo === "boolean") {
        data.payAsYouGo = body.updateProviderConfig.payAsYouGo;
      }
      if (body.updateProviderConfig.unit === "usd" || body.updateProviderConfig.unit === "count") {
        data.unit = body.updateProviderConfig.unit;
        // 切换为按次计费时自动置 payAsYouGo=false（按次渠道有月池概念=次池）
        if (body.updateProviderConfig.unit === "count") data.payAsYouGo = false;
      }
      writeModelsFile(pf, data);
    }

    // 同步价格：从 pi 的 models-store.json 拉最新价，合并进 usage-tracker 模型表
    if (typeof body.syncProvider === "string" && body.syncProvider) {
      const result = syncPricesFromStore(body.syncProvider);
      return NextResponse.json({ ok: true, state, sync: result });
    }

    // 更新单个模型的手动字段（usage/rate/peakRate）
    if (body.updateModel?.modelId) {
      const models = updateModelMeta(
        body.updateModel.provider ?? body.syncProvider ?? "opencode-go",
        body.updateModel.modelId,
        {
        usage: body.updateModel.usage,
        rate: body.updateModel.rate,
        peakRate: body.updateModel.peakRate,
      });
      return NextResponse.json({ ok: true, state, models });
    }

    return NextResponse.json({ ok: true, state });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}