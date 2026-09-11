import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./opencode-quota.ts");
}

/**
 * 倍率派生（本次改动的核心）：
 * rate = 渠道月池 / 模型月额度，不再读表里手写的 rate。
 * 这些用例锁住口径，防止将来又把手写倍率接回来。
 */

// ── 基础倍率派生 ──────────────────────────────────────────────

test("deriveBaseRate: 月池/月额度", async () => {
  const { deriveBaseRate } = await loadSubject();

  assert.equal(deriveBaseRate(60, 60), 1);
  assert.equal(deriveBaseRate(60, 30), 2);
  assert.equal(deriveBaseRate(60, 15), 4);
});

test("deriveBaseRate: 不计额度的情形一律返回 0", async () => {
  const { deriveBaseRate } = await loadSubject();

  assert.equal(deriveBaseRate(60, 0), 0, "免费模型（usage=0）");
  assert.equal(deriveBaseRate(60, undefined), 0, "表里没有该模型");
  assert.equal(deriveBaseRate(0, 15), 0, "渠道无月池（按量计费）");
  assert.equal(deriveBaseRate(60, -1), 0, "脏数据");
});

// ── 高峰乘数 ──────────────────────────────────────────────────

test("peakMultiplierOf: 优先新字段 peakMultiplier", async () => {
  const { peakMultiplierOf } = await loadSubject();

  assert.equal(peakMultiplierOf({ usage: 30, peakMultiplier: 2 }), 2);
  assert.equal(peakMultiplierOf({ usage: 60 }), 1, "无高峰加价");
});

test("peakMultiplierOf: 旧数据用 peakRate/rate 比值还原", async () => {
  const { peakMultiplierOf } = await loadSubject();

  // 旧表形态：rate=2, peakRate=4 → 乘数 2
  assert.equal(peakMultiplierOf({ usage: 30, rate: 2, peakRate: 4 }), 2);
  // rate=4, peakRate=8 → 仍是 2（比值恒定，与 usage 无关）
  assert.equal(peakMultiplierOf({ usage: 15, rate: 4, peakRate: 8 }), 2);
  // peakRate <= rate 视为无高峰
  assert.equal(peakMultiplierOf({ usage: 30, rate: 4, peakRate: 4 }), 1);
  assert.equal(peakMultiplierOf(undefined), 1);
});

// ── 生效倍率（含高峰）──────────────────────────────────────────

test("effectiveRate: 非高峰 = 基础倍率", async () => {
  const { effectiveRate, isOpencodePeakHours } = await loadSubject();

  // 找一个确定的非高峰时刻：周六
  const saturday = Date.UTC(2026, 8, 12, 4, 0, 0); // 2026-09-12 周六
  assert.equal(isOpencodePeakHours(saturday), false);
  assert.equal(effectiveRate(60, { usage: 30 }, saturday), 2);
  assert.equal(
    effectiveRate(60, { usage: 30, peakMultiplier: 2 }, saturday),
    2,
    "非高峰不翻倍",
  );
});

test("effectiveRate: 高峰按乘数翻倍", async () => {
  const { effectiveRate, isOpencodePeakHours } = await loadSubject();

  // 工作日北京 10:00 = UTC 02:00（周一）
  const mondayPeak = Date.UTC(2026, 8, 14, 2, 0, 0);
  assert.equal(isOpencodePeakHours(mondayPeak), true);
  assert.equal(
    effectiveRate(60, { usage: 30, peakMultiplier: 2 }, mondayPeak),
    4,
    "基础 2 × 高峰 2",
  );
  assert.equal(
    effectiveRate(60, { usage: 15, peakMultiplier: 2 }, mondayPeak),
    8,
    "基础 4 × 高峰 2",
  );
  assert.equal(
    effectiveRate(60, { usage: 30 }, mondayPeak),
    2,
    "无 peakMultiplier 的模型高峰不翻倍",
  );
});

// ── 端到端百分比：本次改动的实际目的 ──────────────────────────

test("opencodeQuotaPct: GLM-5.3-Flash 倍率 4→1 后百分比缩到 1/4", async () => {
  const { opencodeQuotaPct, isOpencodePeakHours, OPENCODE_GO_MODEL_META } =
    await loadSubject();

  const saturday = Date.UTC(2026, 8, 12, 4, 0, 0);
  assert.equal(isOpencodePeakHours(saturday), false);

  // 表里只需维护 usage；旧实现写成 rate:4，会让百分比虚高 4 倍
  assert.equal(OPENCODE_GO_MODEL_META["glm-5.3-flash"].usage, 60);

  const cost = 1; // $1
  const pct = opencodeQuotaPct("glm-5.3-flash", cost, saturday);
  // rate = 60/60 = 1 → 1 × 1 / 60 × 100
  assert.ok(pct !== null);
  assert.ok(
    Math.abs(pct - (1 / 60) * 100) < 1e-9,
    `期望 ${(1 / 60) * 100}，实得 ${pct}`,
  );
});

test("opencodeQuotaPct: 与 usage-tracker 的 costUsd/usage 口径一致", async () => {
  const { opencodeQuotaPct, OPENCODE_GO_MODEL_META } = await loadSubject();

  const saturday = Date.UTC(2026, 8, 12, 4, 0, 0);
  const pool = 60;
  const cost = 3.21;

  for (const [model, meta] of Object.entries(OPENCODE_GO_MODEL_META)) {
    if (!meta.usage || meta.usage <= 0) continue;
    const pct = opencodeQuotaPct(model, cost, saturday);
    const expected = (cost / meta.usage) * 100; // usage-tracker 的算法
    assert.ok(
      pct !== null && Math.abs(pct - expected) < 1e-9,
      `${model}: 期望 ${expected}，实得 ${pct}（月池 ${pool}）`,
    );
  }
});

test("opencodeQuotaPct: 免费模型与未知模型返回 null", async () => {
  const { opencodeQuotaPct } = await loadSubject();

  assert.equal(opencodeQuotaPct("ox-alpha-free", 1), null, "usage=0 不计额度");
  assert.equal(opencodeQuotaPct("nonexistent-model", 1), null);
  assert.equal(opencodeQuotaPct("glm-5.2", 0), null, "cost 为 0");
  assert.equal(opencodeQuotaPct(undefined, 1), null);
});

// ── usageQuotaPct：动态表路径（新客户端）───────────────────────

test("usageQuotaPct: 动态表按 usage 派生，忽略表里手写 rate", async () => {
  const mod = await loadSubject();

  // 拦掉网络请求，喂入一张「手写 rate 已过期」的表：
  // usage 已更新为 60，但 rate 仍留着旧的 4 —— 派生逻辑必须忽略它。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        tables: {
          "opencode-go": {
            monthlyQuotaUsd: 60,
            models: { "glm-5.3-flash": { usage: 60, rate: 4 } },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    // 每个用例独占模块实例，避免 metaCache 跨用例污染
    const fresh = await import(`./opencode-quota.ts?v=${Math.random()}`);
    const saturday = Date.UTC(2026, 8, 12, 4, 0, 0);
    const pct = await fresh.usageQuotaPct(
      "opencode-go",
      "glm-5.3-flash",
      1,
      saturday,
    );
    assert.ok(pct !== null);
    assert.ok(
      Math.abs(pct - (1 / 60) * 100) < 1e-9,
      `应忽略手写 rate=4，按 usage=60 派生；实得 ${pct}`,
    );
    assert.equal(typeof mod.usageQuotaPct, "function");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usageQuotaPct: 动态表缺该模型时退回静态表", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        tables: { "opencode-go": { monthlyQuotaUsd: 60, models: {} } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const fresh = await import(`./opencode-quota.ts?v=${Math.random()}`);
    const saturday = Date.UTC(2026, 8, 12, 4, 0, 0);
    const pct = await fresh.usageQuotaPct("opencode-go", "glm-5.2", 1, saturday);
    assert.ok(pct !== null, "应退回静态表而非返回 null");
    assert.ok(Math.abs(pct - (1 / 60) * 100) < 1e-9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usageQuotaPct: 按量计费渠道不显示百分比", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        tables: {
          "Command Code": {
            payAsYouGo: true,
            models: { "some-model": { usage: 15 } },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const fresh = await import(`./opencode-quota.ts?v=${Math.random()}`);
    const pct = await fresh.usageQuotaPct("Command Code", "some-model", 1);
    assert.equal(pct, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
