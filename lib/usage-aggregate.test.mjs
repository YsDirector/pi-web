import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./usage-aggregate.ts");
}

const chan = (over = {}) => ({
  provider: "p",
  pool: 60,
  unit: "usd",
  payAsYouGo: false,
  deltaPct: 0,
  baseline: 0,
  costUsd: 0,
  count: 0,
  ...over,
});

/**
 * 「全部渠道」合计口径：金额加权（Σ池消耗$ / Σ池$），不能把百分比直接相加。
 * 这些用例锁住语义，防止将来退回「ΣquotaPct」。
 */

test("单渠道时退化为「基线 + ΣquotaPct」，与单渠道视图一致", async () => {
  const { aggregateQuota } = await loadSubject();
  const a = aggregateQuota([chan({ provider: "opencode-go", pool: 60, deltaPct: 12.5, baseline: 3 })]);

  assert.equal(a.poolSum, 60);
  assert.equal(a.drawSum, 7.5); // 12.5% × $60
  assert.equal(a.deltaPct, 12.5);
  assert.equal(a.totalPct, 15.5); // 3 + 12.5
});

test("两渠道按金额加权，而非百分比相加", async () => {
  const { aggregateQuota } = await loadSubject();
  // 池 $60 用了 50%（= $30）、池 $70 用了 0%（= $0）
  const a = aggregateQuota([
    chan({ provider: "opencode-go", pool: 60, deltaPct: 50 }),
    chan({ provider: "Command Code", pool: 70, deltaPct: 0 }),
  ]);

  assert.equal(a.poolSum, 130, "Σ池 = 130");
  assert.equal(a.drawSum, 30, "Σ池消耗 = $30");
  assert.equal(a.deltaPct, (30 / 130) * 100, "加权后 ≈ 23.08%");
  assert.notEqual(a.deltaPct, 50 + 0, "绝不能是百分比相加");
});

test("基线按渠道各计一次，合计取和", async () => {
  const { aggregateQuota } = await loadSubject();
  const a = aggregateQuota([
    chan({ provider: "a", pool: 60, deltaPct: 0, baseline: 1.64 }),
    chan({ provider: "b", pool: 70, deltaPct: 0, baseline: 0 }),
  ]);
  assert.equal(a.baselineSum, 1.64);
  assert.equal(a.totalPct, 1.64);
});

test("按量计费 / 按次计费 / 无池渠道不参与合计", async () => {
  const { aggregateQuota } = await loadSubject();
  const a = aggregateQuota([
    chan({ provider: "opencode-go", pool: 60, deltaPct: 10 }),
    chan({ provider: "deepseek", pool: 0, payAsYouGo: true, deltaPct: 99, costUsd: 5 }),
    chan({ provider: "countly", pool: 100, unit: "count", deltaPct: 42 }),
    chan({ provider: "nopool", pool: 0, deltaPct: 7 }),
  ]);

  assert.deepEqual(
    a.poolable.map((c) => c.provider),
    ["opencode-go"],
  );
  assert.equal(a.poolSum, 60, "只有 opencode-go 的池进入合计");
  assert.equal(a.deltaPct, 10, "按量/按次渠道的百分比被排除");
});

test("没有任何可用月池时 totalPct 为 null（面板显示「按量计费」）", async () => {
  const { aggregateQuota } = await loadSubject();
  const a = aggregateQuota([chan({ provider: "deepseek", pool: 0, payAsYouGo: true })]);
  assert.equal(a.poolSum, 0);
  assert.equal(a.totalPct, null);
  assert.equal(a.deltaPct, 0);
});

test("空列表安全", async () => {
  const { aggregateQuota } = await loadSubject();
  const a = aggregateQuota([]);
  assert.equal(a.poolSum, 0);
  assert.equal(a.totalPct, null);
});

test("渠道池消耗金额由 ΣquotaPct 反推 = Σ(cost × rate)", async () => {
  const { channelDrawUsd } = await loadSubject();
  // 池 $60、ΣquotaPct 25% → 消耗 $15
  assert.equal(channelDrawUsd(chan({ pool: 60, deltaPct: 25 })), 15);
  // 不参与合计的渠道不产生消耗额
  assert.equal(channelDrawUsd(chan({ pool: 0, payAsYouGo: true, deltaPct: 90 })), 0);
});

test("超过 100% 的单池占用被如实反映，不做截断", async () => {
  const { aggregateQuota } = await loadSubject();
  const a = aggregateQuota([chan({ provider: "opencode-go", pool: 60, deltaPct: 120 })]);
  assert.equal(a.totalPct, 120, "超额消耗必须暴露出来（面板另有高亮）");
});
