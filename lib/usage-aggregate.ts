/**
 * 「全部渠道」视图的合计口径。
 *
 * 背景：各渠道月池**互相独立、不可转移**（opencode-go $60 用不完不能补到
 * Command Code $70 上），所以跨渠道合计**不能把各渠道百分比直接相加** ——
 * 那样得到的是「各池占用率之和」（可能超过 100%），不是任何单一池的比例。
 *
 * 统一口径（与 usage-tracker / 消息行同源）：
 *
 *   单条 quotaPct = cost × rate / 渠道月池 × 100
 *   ⇒ 渠道 ΣquotaPct = 该渠道月池消耗%
 *   ⇒ 渠道池消耗金额 = ΣquotaPct/100 × 池 = Σ(cost × rate)
 *   合计百分比     = Σ(渠道池消耗金额) / Σ(渠道月池) × 100   ← 金额加权
 *
 * 单渠道时本函数退化为「基线 + ΣquotaPct」，与单渠道视图完全一致。
 * 按量计费（payAsYouGo）与按次计费（unit=count）渠道没有可比的美元分母，
 * 不参与合计（纳入会让合计失去意义）。
 */

export interface ChannelQuotaStat {
  provider: string;
  /** 渠道月池（美元） */
  pool: number;
  /** "usd" | "count" */
  unit: string;
  payAsYouGo: boolean;
  /** 本期账本新增的 ΣquotaPct（%） */
  deltaPct: number;
  /** 账本开始前官方口径的已用百分比（%） */
  baseline: number;
  costUsd: number;
  count: number;
}

export interface AggregateQuota {
  /** Σ 参与合计的渠道月池 */
  poolSum: number;
  /** Σ 渠道池消耗金额（美元） */
  drawSum: number;
  /** Σ 渠道基线（%） */
  baselineSum: number;
  /** 金额加权后的账本新增（%） */
  deltaPct: number;
  /** 合计百分比（%）；无可用月池时为 null */
  totalPct: number | null;
  /** 参与合计的渠道 */
  poolable: ChannelQuotaStat[];
}

/** 该渠道是否纳入「全部渠道」合计：美元订阅池且池 > 0。 */
export function isPoolable(c: ChannelQuotaStat): boolean {
  return !c.payAsYouGo && c.unit === "usd" && c.pool > 0;
}

/** 渠道池消耗金额：由 ΣquotaPct 反推（定义上 = Σ(cost × rate)）。 */
export function channelDrawUsd(c: ChannelQuotaStat): number {
  return isPoolable(c) ? (c.deltaPct / 100) * c.pool : 0;
}

export function aggregateQuota(stats: ChannelQuotaStat[]): AggregateQuota {
  const poolable = stats.filter(isPoolable);
  const poolSum = poolable.reduce((s, c) => s + c.pool, 0);
  const drawSum = poolable.reduce((s, c) => s + channelDrawUsd(c), 0);
  const baselineSum = poolable.reduce((s, c) => s + c.baseline, 0);
  const deltaPct = poolSum > 0 ? (drawSum / poolSum) * 100 : 0;
  const totalPct = poolSum > 0 ? baselineSum + deltaPct : null;
  return { poolSum, drawSum, baselineSum, deltaPct, totalPct, poolable };
}
