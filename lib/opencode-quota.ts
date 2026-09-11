/**
 * OpenCode Go 模型倍率表(pi-web 侧)。
 *
 * 与 ~/.pi/agent/usage-tracker/models/opencode-go.json 保持同步。
 *
 * **倍率由月池派生，不再手写：**
 *   rate = 渠道月池(monthlyQuotaUsd) / 该模型月额度(usage)
 *   pct  = costUsd × rate / 月池 × 100
 * 两条相除即 pct = costUsd / usage × 100 —— 与 usage-tracker 记账口径完全一致，
 * 也与 /usage 页面编辑框的 autoRate 一致（见 app/usage/page.tsx 的「倍率自动」）。
 *
 * 历史上 rate 与 usage 是两个手写字段，容易各自漂移：官方调倍率时必须两处同改，
 * 漏改就会让显示百分比虚高/偏低（例：GLM-5.3-Flash 官方倍率 4→1 时，旧表仍按 4
 * 计算 → 百分比虚高 4 倍）。现只需维护 usage 一个数。
 *
 * 数据来源：https://opencode.ai/docs/go/ 官方定价页（Usage 即模型月额度）
 *   Usage $60 → 倍率 1；Usage $30 → 倍率 2；Usage $15 → 倍率 4
 *
 * 高峰时段：deepseek-v4 系列价格翻倍，用 peakMultiplier 表示（=2），
 * 而非绝对值 peakRate —— 乘数不随 usage 变化，绝对倍率会失效。
 */

export interface OpencodeModelMeta {
  /** 该模型月可用额度（美元）—— **唯一真源**，倍率由它派生 */
  usage: number;
  /** 高峰时段倍率乘数（deepseek-v4 系列价格翻倍 → 2）。缺省 = 无高峰加价 */
  peakMultiplier?: number;
  /** @deprecated 废弃的手写倍率，仅作旧数据兼容，计算时不读取 */
  rate?: number;
  /** @deprecated 废弃的绝对高峰倍率，改用 peakMultiplier */
  peakRate?: number;
}

/** 模型表单条元数据（动态渠道表与静态表共用形状） */
export interface QuotaModelMeta {
  usage: number;
  peakMultiplier?: number;
  /** @deprecated 见 OpencodeModelMeta.rate */
  rate?: number;
  /** @deprecated 见 OpencodeModelMeta.peakRate */
  peakRate?: number;
}

/** /api/usage/meta 返回的单渠道表结构 */
export interface ProviderQuotaTable {
  monthlyQuotaUsd?: number;
  payAsYouGo?: boolean;
  unit?: "usd" | "count";
  models: Record<string, QuotaModelMeta>;
}

export interface QuotaMetaResponse {
  ok: boolean;
  tables: Record<string, ProviderQuotaTable>;
}

/** 月额度池（美元） */
export const OPENCODE_MONTHLY_QUOTA_USD = 60;

/**
 * 基础倍率 = 渠道月池 / 模型月额度。
 * 模型月额度为 0（如免费模型）或月池缺失时返回 0，调用方据此跳过百分比。
 */
export function deriveBaseRate(
  monthlyQuotaUsd: number,
  usage: number | undefined,
): number {
  if (!usage || usage <= 0 || !(monthlyQuotaUsd > 0)) return 0;
  return monthlyQuotaUsd / usage;
}

/**
 * 高峰倍率乘数。
 *
 * 优先新字段 peakMultiplier；旧数据只有绝对 peakRate 时，用 peakRate/rate 的
 * **比值**还原乘数 —— 比值是定价方案级别的事实，不随 usage 变动而失效。
 */
export function peakMultiplierOf(meta: QuotaModelMeta | undefined): number {
  if (!meta) return 1;
  if (typeof meta.peakMultiplier === "number" && meta.peakMultiplier > 1) {
    return meta.peakMultiplier;
  }
  const r = meta.rate;
  const pr = meta.peakRate;
  if (typeof pr === "number" && typeof r === "number" && r > 0 && pr > r) {
    return pr / r;
  }
  return 1;
}

/** 生效倍率（含高峰翻倍）= 基础倍率 × 高峰乘数；不计额度时返回 0 */
export function effectiveRate(
  monthlyQuotaUsd: number,
  meta: QuotaModelMeta,
  ts: number = Date.now(),
): number {
  const base = deriveBaseRate(monthlyQuotaUsd, meta.usage);
  if (base <= 0) return 0;
  return isOpencodePeakHours(ts) ? base * peakMultiplierOf(meta) : base;
}

/**
 * 高峰时段判断（北京时间）：周一至周五 9:00-12:00 与 14:00-18:00。
 * 高峰时 deepseek-v4 系列价格翻倍（基础倍率 × peakMultiplier）。
 */
export function isOpencodePeakHours(ts: number = Date.now()): boolean {
  // 北京时间 = UTC+8
  const d = new Date(ts + 8 * 3600 * 1000);
  const day = d.getUTCDay(); // 0=日 6=六
  if (day === 0 || day === 6) return false; // 周末全天空闲
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (
    (minutes >= 9 * 60 && minutes < 12 * 60) ||
    (minutes >= 14 * 60 && minutes < 18 * 60)
  );
}

/**
 * 静态兜底模型表（/api/usage/meta 不可用时使用）。
 *
 * **只需维护 usage**（模型月额度 $），倍率由 60/usage 自动派生。
 */
export const OPENCODE_GO_MODEL_META: Record<string, OpencodeModelMeta> = {
  "grok-4.6": { usage: 15 },
  "gpt-5.6-luna": { usage: 15 },
  // 2026-09-10 官方倍率 4→1（配额 1580→6320 次/5h）→ 模型月额度 15→60
  "glm-5.3-flash": { usage: 60 },
  "glm-5.3": { usage: 15 },
  "glm-5.2": { usage: 60 },
  "glm-5.1": { usage: 60 },
  "kimi-k3": { usage: 15 },
  "kimi-k2.7-code": { usage: 60 },
  "kimi-k2.6": { usage: 60 },
  "longcat-2.0": { usage: 60 },
  "mimo-v2.5": { usage: 60 },
  "mimo-v2.5-pro": { usage: 15 },
  "minimax-m3": { usage: 60 },
  "minimax-m2.7": { usage: 60 },
  "minimax-m2.5": { usage: 60 },
  "muse-spark-1.3-contributor": { usage: 60 },
  "muse-spark-1.2-contributor": { usage: 60 },
  "qwen3.8-max": { usage: 15 },
  "qwen3.8-flash": { usage: 30 },
  "qwen3.7-max": { usage: 30 },
  "qwen3.7-plus": { usage: 60 },
  "qwen3.6-plus": { usage: 60 },
  "deepseek-v4-pro": { usage: 15, peakMultiplier: 2 },
  "deepseek-v4-flash": { usage: 30, peakMultiplier: 2 },
  "deepseek-v4-flash-vision-exp": { usage: 15, peakMultiplier: 2 },
  "hy4-preview": { usage: 30 },
  "hy3": { usage: 60 },
  // 免费/无额度模型
  "ox-alpha-free": { usage: 0 },
};

/**
 * 按模型计算「月额度消耗百分比」（静态表兜底路径）。
 * pct = costUsd × rate / 60 × 100，rate = 60 / usage；不计额度时返回 null。
 */
export function opencodeQuotaPct(
  model: string | undefined,
  costUsd: number | undefined,
  ts: number = Date.now(),
): number | null {
  if (!model || !costUsd || costUsd <= 0) return null;
  const meta = OPENCODE_GO_MODEL_META[model];
  if (!meta) return null;
  const rate = effectiveRate(OPENCODE_MONTHLY_QUOTA_USD, meta, ts);
  if (rate <= 0) return null;
  return (costUsd * rate) / OPENCODE_MONTHLY_QUOTA_USD * 100;
}

// ── 多渠道通用版：从 /api/usage/meta 读各 provider 模型表，静态 opencode-go 表兜底 ──

const META_URL = "/api/usage/meta";

/**
 * 消息行月额度百分比的通用计算。
 *
 * 数据源优先级：
 *   1. /api/usage/meta 按 provider 返回的模型表（与 /usage 看板/usage-tracker 同源）；
 *      模型表缺失某模型或渠道按量计费（payAsYouGo）时返回 null。
 *   2. 兜底：provider 为 opencode-go（或其表内短 id）时退回静态 OPENCODE_GO_MODEL_META。
 *
 * pct = costUsd × rate / 渠道月额度 × 100，其中 rate = 渠道月额度 / 模型月额度
 * （高峰时段再乘 peakMultiplier）。注意 rate 由 usage 派生，渠道表里的手写
 * rate 字段已不再被读取。
 */
export async function usageQuotaPct(
  provider: string | undefined,
  model: string | undefined,
  costUsd: number | undefined,
  ts: number = Date.now(),
): Promise<number | null> {
  if (!model || !costUsd || costUsd <= 0) return null;
  const tables = await loadQuotaMeta();
  const providerKey = provider ?? "opencode-go";
  const table = tables[providerKey];
  if (table) {
    // 按量计费渠道不显示百分比（无月池概念）
    if (table.payAsYouGo || table.unit === "count") return null;
    const monthly = table.monthlyQuotaUsd;
    const meta = table.models?.[model];
    if (!monthly || monthly <= 0 || !meta) return null;
    const rate = effectiveRate(monthly, meta, ts);
    if (rate <= 0) return null;
    return (costUsd * rate) / monthly * 100;
  }
  // 兜底：静态 opencode-go 表（接口不可用或该渠道无文件时）
  return opencodeQuotaPct(model, costUsd, ts);
}

let metaCache: Promise<Record<string, ProviderQuotaTable>> | null = null;

/** 拉取一次 /api/usage/meta 并缓存（失败返回空表，不抛异常）。 */
export function loadQuotaMeta(): Promise<Record<string, ProviderQuotaTable>> {
  if (metaCache) return metaCache;
  metaCache = (async () => {
    // SSR/测试环境无 fetch 目标时静默降级
    if (typeof window === "undefined") return {};
    try {
      const res = await fetch(META_URL, { cache: "no-store" });
      if (!res.ok) return {};
      const data = (await res.json()) as QuotaMetaResponse;
      return data.ok ? data.tables : {};
    } catch {
      return {};
    }
  })();
  // 失败后允许下次重试
  metaCache.catch(() => { metaCache = null; });
  return metaCache;
}
