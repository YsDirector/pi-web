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
  /** 倍率 = 60 / usage */
  rate: number;
}

/** 月额度池（美元） */
export const OPENCODE_MONTHLY_QUOTA_USD = 60;

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
  "deepseek-v4-pro": { usage: 15, rate: 4 },
  "deepseek-v4-flash": { usage: 30, rate: 2 },
  "deepseek-v4-flash-vision-exp": { usage: 15, rate: 4 },
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
): number | null {
  if (!model || !costUsd || costUsd <= 0) return null;
  const meta = OPENCODE_GO_MODEL_META[model];
  if (!meta || meta.rate <= 0) return null;
  return (costUsd * meta.rate) / OPENCODE_MONTHLY_QUOTA_USD * 100;
}