/**
 * OpenCode Go 模型倍率表(pi-web 侧)。
 *
 * 与 ~/.pi/agent/usage-tracker/opencode-go-models.json 保持同步：
 * 月额度百分比 = costUsd × rate / 60 × 100（月池 $60）。
 *
 * 数据来源：https://opencode.ai/docs/go/ 官方定价页
 *   Usage $60 → 倍率 1（MiMo-V2.5、GLM-5.2、Kimi K2.6 ...）
 *   Usage $30 → 倍率 2（DeepSeek V4 Flash、Qwen3.8 Flash、Hy4 ...）
 *   Usage $15 → 倍率 4（GLM-5.3、Grok 4.6、DeepSeek V4 Pro、Kimi K3 ...）
 */

export interface OpencodeModelMeta {
  /** 该模型月可用额度（美元） */
  usage: number;
  /** 倍率 = 60 / usage（Off-Peak 基础倍率） */
  rate: number;
  /** 高峰时段倍率（deepseek-v4 系列价格翻倍） */
  peakRate?: number;
}

/** 月额度池（美元） */
export const OPENCODE_MONTHLY_QUOTA_USD = 60;

/**
 * 高峰时段判断（北京时间）：周一至周五 9:00-12:00 与 14:00-18:00。
 * 高峰时 deepseek-v4 系列价格翻倍（等效倍率翻倍，flash: 2→4, pro: 4→8）。
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

export const OPENCODE_GO_MODEL_META: Record<string, OpencodeModelMeta> = {
  "grok-4.6": { usage: 15, rate: 4 },
  "gpt-5.6-luna": { usage: 15, rate: 4 },
  "glm-5.3-flash": { usage: 15, rate: 4 },
  "glm-5.3": { usage: 15, rate: 4 },
  "glm-5.2": { usage: 60, rate: 1 },
  "glm-5.1": { usage: 60, rate: 1 },
  "kimi-k3": { usage: 15, rate: 4 },
  "kimi-k2.7-code": { usage: 60, rate: 1 },
  "kimi-k2.6": { usage: 60, rate: 1 },
  "longcat-2.0": { usage: 60, rate: 1 },
  "mimo-v2.5": { usage: 60, rate: 1 },
  "mimo-v2.5-pro": { usage: 15, rate: 4 },
  "minimax-m3": { usage: 60, rate: 1 },
  "minimax-m2.7": { usage: 60, rate: 1 },
  "minimax-m2.5": { usage: 60, rate: 1 },
  "muse-spark-1.3-contributor": { usage: 60, rate: 1 },
  "muse-spark-1.2-contributor": { usage: 60, rate: 1 },
  "qwen3.8-max": { usage: 15, rate: 4 },
  "qwen3.8-flash": { usage: 30, rate: 2 },
  "qwen3.7-max": { usage: 30, rate: 2 },
  "qwen3.7-plus": { usage: 60, rate: 1 },
  "qwen3.6-plus": { usage: 60, rate: 1 },
  "deepseek-v4-pro": { usage: 15, rate: 4, peakRate: 8 },
  "deepseek-v4-flash": { usage: 30, rate: 2, peakRate: 4 },
  "deepseek-v4-flash-vision-exp": { usage: 15, rate: 4, peakRate: 8 },
  "hy4-preview": { usage: 30, rate: 2 },
  "hy3": { usage: 60, rate: 1 },
  // 免费/无额度模型
  "ox-alpha-free": { usage: 0, rate: 0 },
};

/**
 * 按模型计算"月额度消耗百分比"。
 * pct = costUsd × rate / 60 × 100；模型未知或 rate≤0 时返回 null。
 */
export function opencodeQuotaPct(
  model: string | undefined,
  costUsd: number | undefined,
  ts: number = Date.now(),
): number | null {
  if (!model || !costUsd || costUsd <= 0) return null;
  const meta = OPENCODE_GO_MODEL_META[model];
  if (!meta || meta.rate <= 0) return null;
  // 高峰时段（北京时间工作日上午/下午）deepseek-v4 系列倍率翻倍
  const rate = meta.peakRate && isOpencodePeakHours(ts) ? meta.peakRate : meta.rate;
  return (costUsd * rate) / OPENCODE_MONTHLY_QUOTA_USD * 100;
}