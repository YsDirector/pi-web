"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface DailyProviderAgg {
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

interface DailyAgg {
  date: string;
  byProvider: DailyProviderAgg[];
  totalTokens: number;
  costUsd: number;
  quotaPct: number;
}

interface UsageApiResponse {
  ok: boolean;
  providers: string[];
  provider: string | null;
  state: {
    enabled: boolean;
    periodStartTs: number;
    periodStartIso: string | null;
    baselines: Record<string, number>;
    baselineQuotaPct: number;
  };
  quota: {
    monthlyQuotaUsd: number;
    payAsYouGo?: boolean;
    unit?: "usd" | "count";
    countUsed?: number;
    totalPct: number | null;
    deltaPct: number;
    costUsd: number;
    count: number;
    tokens: { input: number; output: number; total: number };
  };
  daily: DailyAgg[];
  byModel: Array<{
    model: string;
    provider?: string;
    count: number;
    costUsd: number;
    quotaPct: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    rate?: number;
    peakRate?: number;
    modelUsageUsd?: number;
  }>;
  models: Array<{ id: string; provider?: string | null; usageUsd: number; rate: number; peakRate?: number; inPrice: number; outPrice: number; crPrice: number; cwPrice: number }>;
  storePrices: Record<string, Record<string, { in: number; out: number; cr: number; cw: number; name?: string }>>;
  peakNow: boolean;
  ledger: Array<{
    ts: number;
    iso: string;
    source: string;
    model: string;
    totalTokens: number;
    costUsd: number;
    rate: number;
    quotaPct: number;
  }>;
}

type ChartMode = "tokens" | "usd" | "pct";

function makeBar(pct: number, width = 24): string {
  const filled = Math.min(width, Math.max(0, Math.floor((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

function fmtTokens(v: number): string {
  return v.toLocaleString();
}

function fmtCompact(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

const CHART_COLORS = {
  input: "var(--accent)",
  output: "#22c55e",
  cacheRead: "#94a3b8",
  cacheWrite: "#f59e0b",
};

/** 渠道 → 颜色：稳定映射，多渠道时从调色板分配 */
const PROVIDER_PALETTE = [
  "var(--accent)", // opencode-go 主色
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6",
];
function providerColor(provider: string): string {
  // 常见渠道固定色
  const fixed: Record<string, string> = {
    "opencode-go": "var(--accent)",
    deepseek: "#8b5cf6",
    opencode: "#f59e0b",
  };
  if (fixed[provider]) return fixed[provider];
  let hash = 0;
  for (const ch of provider) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PROVIDER_PALETTE[hash % PROVIDER_PALETTE.length];
}

export default function UsagePage() {
  const [data, setData] = useState<UsageApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"dashboard" | "settings">("dashboard");
  const [chartMode, setChartMode] = useState<ChartMode>("tokens");
  const [editingBaseline, setEditingBaseline] = useState(false);
  const [baselineInput, setBaselineInput] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<string>("opencode-go");
  const [modelEdits, setModelEdits] = useState<Record<string, { usage?: string; rate?: string; peakRate?: string }>>({});

  const load = useCallback(async (provider: string | null) => {
    setLoading(true);
    try {
      const url = provider ? `/api/usage?provider=${encodeURIComponent(provider)}` : "/api/usage";
      const res = await fetch(url);
      const json = (await res.json()) as UsageApiResponse;
      if (!res.ok || !json.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(activeProvider);
  }, [activeProvider, load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/usage", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as UsageApiResponse & { error?: string };
        if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        await load(activeProvider);
        setStatusMsg("保存成功");
        setTimeout(() => setStatusMsg(null), 2000);
      } catch (e) {
        setStatusMsg(e instanceof Error ? `失败: ${e.message}` : "保存失败");
      }
    },
    [load, activeProvider],
  );

  const handleReset = useCallback(() => {
    if (!confirm("确定重置统计周期？基线会清零，账本从当前时刻重新累计（充值后使用）。")) return;
    patch({ reset: true });
  }, [patch]);

  const handleBaselineSave = useCallback(() => {
    const v = parseFloat(baselineInput);
    if (!Number.isFinite(v) || v < 0) {
      setStatusMsg("无效的百分比值");
      return;
    }
    patch({ baselineQuotaPct: v });
    setEditingBaseline(false);
  }, [baselineInput, patch]);

  const [providerQuotaInput, setProviderQuotaInput] = useState<string>("60");
  const [providerPaygInput, setProviderPaygInput] = useState<boolean>(false);
  const [providerUnitInput, setProviderUnitInput] = useState<"usd" | "count">("usd");

  const handleSaveProviderConfig = useCallback(async () => {
    const quotaVal = parseFloat(providerQuotaInput);
    if (!Number.isFinite(quotaVal) || quotaVal <= 0) {
      setStatusMsg("无效的渠道总额度");
      return;
    }
    try {
      const res = await fetch("/api/usage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updateProviderConfig: {
            provider: settingsProvider,
            monthlyQuotaUsd: quotaVal,
            payAsYouGo: providerPaygInput,
            unit: providerUnitInput,
          },
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setStatusMsg(`已保存渠道 ${settingsProvider} 配置`);
      await load(settingsProvider);
    } catch (e) {
      setStatusMsg(e instanceof Error ? `保存失败: ${e.message}` : "保存失败");
    }
  }, [providerQuotaInput, providerPaygInput, providerUnitInput, settingsProvider, load]);

  const handleSyncPrices = useCallback(async () => {
    setSyncBusy(true);
    try {
      const res = await fetch("/api/usage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncProvider: settingsProvider }),
      });
      const json = (await res.json()) as UsageApiResponse & { sync?: { updated: string[]; added: string[]; missing: string[] } };
      if (!res.ok || !json.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      const r = json.sync;
      setStatusMsg(
        `同步完成：更新 ${r?.updated?.length ?? 0} 个价格，新增 ${r?.added?.length ?? 0} 个模型` +
        (r?.missing?.length ? `，${r.missing.length} 个模型在 pi 目录中缺失（已保留）` : ""),
      );
      await load(activeProvider);
    } catch (e) {
      setStatusMsg(e instanceof Error ? `同步失败: ${e.message}` : "同步失败");
    } finally {
      setSyncBusy(false);
    }
  }, [settingsProvider, load, activeProvider]);

  const handleSaveModelMeta = useCallback(
    async (modelId: string) => {
      const edit = modelEdits[modelId];
      if (!edit) return;
      const usage = edit.usage !== undefined && edit.usage !== "" ? parseFloat(edit.usage) : undefined;
      const rate = edit.rate !== undefined && edit.rate !== "" ? parseFloat(edit.rate) : undefined;
      const peakRate = edit.peakRate !== undefined && edit.peakRate !== "" ? parseFloat(edit.peakRate) : undefined;
      if ((usage !== undefined && !Number.isFinite(usage)) || (rate !== undefined && !Number.isFinite(rate)) || (peakRate !== undefined && !Number.isFinite(peakRate))) {
        setStatusMsg("无效的数值");
        return;
      }
      try {
        const res = await fetch("/api/usage", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            updateModel: {
              modelId,
              usage,
              rate,
              peakRate: peakRate === undefined ? undefined : peakRate,
            },
          }),
        });
        const json = (await res.json()) as UsageApiResponse & { error?: string };
        if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setModelEdits((prev) => {
          const next = { ...prev };
          delete next[modelId];
          return next;
        });
        setStatusMsg(`已保存 ${modelId}`);
        await load(activeProvider);
      } catch (e) {
        setStatusMsg(e instanceof Error ? `保存失败: ${e.message}` : "保存失败");
      }
    },
    [modelEdits, load, activeProvider],
  );

  const MAX_CHART_DAYS = 30;

  const chartData = useMemo(() => {
    if (!data) return [];
    // 最多显示最近 30 天（日期已按升序排列）
    return data.daily.slice(-MAX_CHART_DAYS);
  }, [data]);

  // 账本中出现过的渠道（图表图例 & 颜色）
  const providerList = useMemo(() => {
    const set = new Set<string>();
    for (const d of chartData) {
      for (const p of d.byProvider) set.add(p.provider);
    }
    return Array.from(set).sort();
  }, [chartData]);

  const chartMax = useMemo(() => {
    if (!chartData.length) return 1;
    if (chartMode === "usd") return Math.max(...chartData.map((d) => d.costUsd), 0.001);
    if (chartMode === "pct") return Math.max(...chartData.map((d) => d.quotaPct), 0.001);
    return Math.max(...chartData.map((d) => d.totalTokens), 1);
  }, [chartData, chartMode]);

  if (loading && !data) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>
        加载用量看板…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#ef4444", flexDirection: "column", gap: 12 }}>
        <div>加载失败：{error}</div>
        <button onClick={() => load(activeProvider)} style={btnStyle("var(--accent)")}>重试</button>
      </div>
    );
  }

  const { quota, state, byModel, peakNow, models, providers, provider } = data;
  const sortedModels = [...byModel].sort((a, b) => b.quotaPct - a.quotaPct);
  const modelMetaById = new Map(models.map((m) => [m.id, m]));

  return (
    <div style={{ height: "100vh", overflowY: "auto", overflowX: "hidden", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-noto-mono), monospace", fontSize: 13 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px 60px" }}>
        {/* 头部 */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            📊 AI 渠道用量看板
          </h1>
          <a href="/" style={{ color: "var(--accent)", textDecoration: "none", fontSize: 12 }}>
            ← 返回聊天
          </a>
        </div>
        <div style={{ color: "var(--text-dim)", fontSize: 12, marginBottom: 16 }}>
          {peakNow
            ? "当前为高峰时段（deepseek-v4 价格 ×2，倍率翻倍）"
            : "当前为空闲时段（deepseek-v4 基础倍率）"}
          {" · "}月统计自{" "}
          {state.periodStartIso
            ? new Date(state.periodStartIso).toLocaleString("zh-CN")
            : "账本起始（未手动重置）"}
        </div>

        {/* 渠道标签页 */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 10 }}>
          <TabButton active={activeView === "dashboard" && provider === null} onClick={() => { setActiveView("dashboard"); setActiveProvider(null); }} label="全部渠道" />
          {providers.map((p) => (
            <TabButton key={p} active={activeView === "dashboard" && provider === p} onClick={() => { setActiveView("dashboard"); setActiveProvider(p); }} label={p} />
          ))}
          <span style={{ flex: 1 }} />
          <TabButton
            active={activeView === "settings"}
            onClick={() => { setActiveView("settings"); setSettingsProvider(provider ?? "opencode-go"); }}
            label="⚙️ 设置"
          />
        </div>

        {activeView === "settings" ? (
          <SettingsView
            provider={settingsProvider}
            providers={providers}
            models={data.models}
            storePrices={data.storePrices}
            modelEdits={modelEdits}
            syncBusy={syncBusy}
            monthlyQuotaUsd={data.quota.monthlyQuotaUsd}
            payAsYouGo={data.quota.payAsYouGo ?? false}
            onProviderChange={(p) => {
              setSettingsProvider(p);
              setActiveProvider(p); // 触发重新 fetch，models 变为该渠道表
            }}
            onQuotaChange={(v) => {
              setProviderQuotaInput(v);
            }}
            onPaygChange={(v) => setProviderPaygInput(v)}
            onUnitChange={(u) => setProviderUnitInput(u)}
            unit={data.quota.unit ?? "usd"}
            providerUnitInput={providerUnitInput}
            onSaveProviderConfig={handleSaveProviderConfig}
            onQuotaInputReset={(quota, payg, unit) => {
              setProviderQuotaInput(String(quota ?? 60));
              setProviderPaygInput(payg ?? false);
              setProviderUnitInput(unit ?? "usd");
            }}
            onEditChange={(modelId, field, value) => setModelEdits((prev) => ({ ...prev, [modelId]: { ...prev[modelId], [field]: value } }))}
            onSync={handleSyncPrices}
            onSaveModel={handleSaveModelMeta}
          />
        ) : (
          <>
        {/* 总消耗卡片 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
          {quota.payAsYouGo ? (
            <MetricCard label="计费模式" value="按量计费" sub="无月池，仅统计成本与 tokens" />
          ) : quota.unit === "count" ? (
            <MetricCard
              label="调用次数额度"
              value={quota.totalPct !== null ? `${quota.totalPct.toFixed(2)}%` : "—"}
              sub={`已用 ${quota.countUsed ?? 0} 次 / 总额 ${quota.monthlyQuotaUsd} 次`}
            />
          ) : (
            <MetricCard
              label="月额度消耗"
              value={quota.totalPct !== null ? `${quota.totalPct.toFixed(3)}%` : "—"}
              sub={`基线 ${state.baselineQuotaPct.toFixed(2)}% + 新增 ${quota.deltaPct.toFixed(3)}%`}
            />
          )}
          <MetricCard label="当前成本（账本）" value={fmtUsd(quota.costUsd)} sub={`${quota.count} 次请求`} />
          <MetricCard label="Tokens" value={fmtTokens(quota.tokens.total)} sub={`in ${fmtTokens(quota.tokens.input)} · out ${fmtTokens(quota.tokens.output)}`} />
        </div>

        {/* 进度条（订阅月池 / 按次计费显示；纯按量美元不显示） */}
        {!quota.payAsYouGo && quota.totalPct !== null && (
          <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 18, marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>
                {quota.unit === "count" ? `次数池 ${quota.monthlyQuotaUsd} 次` : `月池 ${fmtUsd(quota.monthlyQuotaUsd)}`}
              </span>
              <span style={{ color: quota.totalPct >= 80 ? "#ef4444" : quota.totalPct >= 60 ? "#f59e0b" : "var(--text-dim)" }}>
                {quota.totalPct.toFixed(2)}% 已消耗
              </span>
            </div>
            <div style={{ display: "flex", gap: 3 }}>
              <div
                style={{
                  height: 16,
                  borderRadius: 4,
                  background: "linear-gradient(90deg, var(--accent), #f59e0b)",
                  width: `${Math.min(100, quota.totalPct)}%`,
                  minWidth: 4,
                }}
              />
              <div style={{ flex: 1, background: "var(--border)", borderRadius: 4 }} />
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6, fontFamily: "monospace" }}>
              {makeBar(quota.totalPct, 40)} {quota.totalPct.toFixed(2)}%
              {quota.unit === "count" && ` · ${quota.countUsed ?? 0}/${quota.monthlyQuotaUsd} 次`}
            </div>
          </div>
        )}

        {/* 操作区 */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 24 }}>
          {editingBaseline ? (
            <>
              <input
                type="number"
                step="0.1"
                value={baselineInput}
                onChange={(e) => setBaselineInput(e.target.value)}
                placeholder="基线百分比（如 69.6）"
                style={{ width: 180, height: 32, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }}
              />
              <button onClick={handleBaselineSave} style={btnStyle("var(--accent)")}>保存基线</button>
              <button onClick={() => setEditingBaseline(false)} style={btnStyle("var(--text-dim)")}>取消</button>
            </>
          ) : (
            <button onClick={() => { setBaselineInput(String(state.baselineQuotaPct)); setEditingBaseline(true); }} style={btnStyle("var(--accent)")}>
              修改基线（当前 {state.baselineQuotaPct.toFixed(2)}%）
            </button>
          )}
          <button onClick={handleReset} style={btnStyle("#ef4444")}>重置周期（充值后）</button>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>记账状态：{state.enabled ? "● 启用" : "○ 停用"}</span>
          {statusMsg && <span style={{ fontSize: 12, color: "#16a34a" }}>{statusMsg}</span>}
        </div>

        {/* 每日条形图 */}
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "28px 0 10px" }}>每日消耗（按渠道分组，近 {MAX_CHART_DAYS} 天）</h2>
        <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 18px", marginBottom: 24, overflowX: "auto" }}>
          {/* 模式切换 */}
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            <ModeButton active={chartMode === "tokens"} onClick={() => setChartMode("tokens")} label="Tokens" />
            <ModeButton active={chartMode === "usd"} onClick={() => setChartMode("usd")} label="金额 $/天" />
            <ModeButton active={chartMode === "pct"} onClick={() => setChartMode("pct")} label="额度 %/天" />
          </div>

          {chartData.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 12, padding: 20, textAlign: "center" }}>暂无按日数据（扩展加载后产生请求才记录）</div>
          ) : (
            <>
              {/* 日期分组：每天一组，组内每渠道一根柱 */}
              <div style={{ display: "flex", alignItems: "flex-end", gap: 0, height: 180, padding: "4px 2px", borderBottom: "1px solid var(--border)" }}>
                {chartData.map((d) => (
                  <DayGroup
                    key={d.date}
                    date={d.date}
                    providers={d.byProvider}
                    max={chartMax}
                    mode={chartMode}
                  />
                ))}
              </div>
              {/* 日期刻度 */}
              <div style={{ display: "flex", marginTop: 6 }}>
                {chartData.map((d) => {
                  const day = d.date.slice(5); // MM-DD
                  return (
                    <div key={d.date} style={{ flexGrow: 1, flexBasis: 0, fontSize: 9, color: "var(--text-dim)", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden" }}>
                      {day}
                    </div>
                  );
                })}
              </div>
              {/* 图例：token 类型 + 渠道 */}
              <div style={{ display: "flex", gap: 14, marginTop: 12, flexWrap: "wrap", fontSize: 11 }}>
                {chartMode === "tokens" ? (
                  <>
                    <Legend color={CHART_COLORS.input} label="输入" />
                    <Legend color={CHART_COLORS.output} label="输出" />
                    <Legend color={CHART_COLORS.cacheRead} label="缓存读" />
                    <Legend color={CHART_COLORS.cacheWrite} label="缓存写" />
                  </>
                ) : null}
                {providerList.map((p) => (
                  <Legend key={p} color={providerColor(p)} label={p} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* 按模型明细 */}
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "28px 0 10px" }}>按模型（本次周期新增）</h2>
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "rgba(120,120,120,0.08)", color: "var(--text-dim)", textAlign: "left" }}>
                <th style={thStyle()}>模型</th>
                <th style={thStyle()}>请求</th>
                <th style={thStyle()}>Tokens</th>
                <th style={thStyle()}>美元</th>
                <th style={thStyle()}>额度%</th>
                <th style={thStyle()}>倍率</th>
              </tr>
            </thead>
            <tbody>
              {sortedModels.map((m) => {
                const meta = modelMetaById.get(m.model);
                return (
                  <tr key={`${m.provider ?? ""}:${m.model}`} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={tdStyle()}>
                      {m.provider && m.provider !== "unknown" && (
                        <span style={{ color: providerColor(m.provider), fontSize: 10, marginRight: 4 }}>[{m.provider}]</span>
                      )}
                      {m.model}
                      {meta && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>（月额度 ${meta.usageUsd}）</span>}
                    </td>
                    <td style={tdStyle()}>{m.count}</td>
                    <td style={tdStyle()}>{fmtTokens(m.totalTokens)}</td>
                    <td style={tdStyle()}>{fmtUsd(m.costUsd)}</td>
                    <td style={tdStyle()}>{m.quotaPct.toFixed(4)}%</td>
                    <td style={tdStyle()}>
                      {m.rate}
                      {m.peakRate && m.peakRate !== m.rate && <span style={{ color: "#f59e0b" }}>（高峰 {m.peakRate}）</span>}
                    </td>
                  </tr>
                );
              })}
              {sortedModels.length === 0 && (
                <tr><td colSpan={6} style={{ ...tdStyle(), textAlign: "center", color: "var(--text-dim)" }}>暂无记账数据（扩展加载后产生请求才记录）</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 模型倍率参考表 */}
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "28px 0 10px" }}>模型倍率表（{models.length} 个）</h2>
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "rgba(120,120,120,0.08)", color: "var(--text-dim)", textAlign: "left" }}>
                <th style={thStyle()}>模型</th>
                <th style={thStyle()}>月额度 $</th>
                <th style={thStyle()}>倍率</th>
                <th style={thStyle()}>高峰倍率</th>
              </tr>
            </thead>
            <tbody>
              {[...models].sort((a, b) => a.usageUsd - b.usageUsd).map((m) => (
                <tr key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={tdStyle()}>{m.id}</td>
                  <td style={tdStyle()}>{m.usageUsd}</td>
                  <td style={tdStyle()}>{m.rate}</td>
                  <td style={tdStyle()}>{m.peakRate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 最近记账明细 */}
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "28px 0 10px" }}>最近记录（最近 50 条）</h2>
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 11 }}>
            {data.ledger.map((e, i) => (
              <li key={i} style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
                <span style={{ color: "var(--text-dim)" }}>{new Date(e.ts).toLocaleString("zh-CN")}</span>
                <span>[{e.source}]</span>
                <span style={{ fontWeight: 600 }}>{e.model}</span>
                <span>{fmtTokens(e.totalTokens)} tok</span>
                <span>{fmtUsd(e.costUsd)}</span>
                <span>rate {e.rate}</span>
                <span style={{ color: "var(--accent)" }}>{e.quotaPct.toFixed(4)}%</span>
              </li>
            ))}
            {data.ledger.length === 0 && (
              <li style={{ padding: 12, color: "var(--text-dim)", textAlign: "center" }}>暂无记录</li>
            )}
          </ul>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 子组件 ──

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 14px",
        borderRadius: 6,
        border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
        background: active ? "rgba(120,120,120,0.16)" : "var(--bg-panel)",
        color: active ? "var(--accent)" : "var(--text-dim)",
        fontSize: 12,
        cursor: "pointer",
        fontWeight: active ? 700 : 400,
      }}
    >
      {label}
    </button>
  );
}

function ModeButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        borderRadius: 5,
        border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
        background: active ? "rgba(120,120,120,0.16)" : "var(--bg-panel)",
        color: active ? "var(--accent)" : "var(--text-dim)",
        fontSize: 11,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}

function SingleBar({ value, max, color, title }: { value: number; max: number; color: string; title: string }) {
  const heightPct = Math.max(2, (value / max) * 100);
  return (
    <div title={title} style={{ flex: 1, height: 160, display: "flex", alignItems: "flex-end", minWidth: 6, cursor: "pointer" }}>
      <div style={{ width: "100%", height: `${heightPct}%`, background: color, borderRadius: 2 }} />
    </div>
  );
}

/**
 * 日期分组：组内每个渠道一根柱。
 * tokens 模式：柱内堆叠 in/out/cacheR/cacheW 四段；
 * usd/pct 模式：柱为渠道色单色，高度=渠道该模式值。
 */
function DayGroup({
  date,
  providers,
  max,
  mode,
}: {
  date: string;
  providers: DailyProviderAgg[];
  max: number;
  mode: ChartMode;
}) {
  // 排序：渠道数多的排前（视觉稳定），再按名
  const sorted = [...providers].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
  const width = Math.max(sorted.length * 16, 20);
  return (
    <div
      title={`${date}: ${mode === "tokens" ? fmtTokens(providers.reduce((s, x) => s + x.totalTokens, 0)) + " tok" : mode === "usd" ? fmtUsd(providers.reduce((s, x) => s + x.costUsd, 0)) : providers.reduce((s, x) => s + x.quotaPct, 0).toFixed(4) + "%"}`}
      style={{ flexGrow: 1, flexBasis: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 3, padding: "0 2px", minWidth: width, maxWidth: width, height: "100%" }}
    >
      {sorted.map((p) => {
        const value = mode === "tokens" ? p.totalTokens : mode === "usd" ? p.costUsd : p.quotaPct;
        const detail =
          mode === "tokens"
            ? `in ${fmtTokens(p.inputTokens)} · out ${fmtTokens(p.outputTokens)} · cacheR ${fmtTokens(p.cacheReadTokens)} · cacheW ${fmtTokens(p.cacheWriteTokens)}`
            : mode === "usd"
              ? fmtUsd(p.costUsd)
              : `${p.quotaPct.toFixed(4)}%`;
        if (mode === "tokens") {
          return (
            <StackedTokenBar
              key={p.provider}
              provider={p.provider}
              agg={p}
              max={max}
              title={`${date} [${p.provider}]: ${detail}`}
            />
          );
        }
        return (
          <div
            key={p.provider}
            title={`${date} [${p.provider}]: ${detail}`}
            style={{ width: 12, height: "100%", display: "flex", alignItems: "flex-end", cursor: "pointer" }}
          >
            <div style={{ width: "100%", height: `${Math.max(2, (value / (max || 1)) * 100)}%`, background: providerColor(p.provider), borderRadius: 2 }} />
          </div>
        );
      })}
    </div>
  );
}

/** 单渠道柱：堆叠 in/out/cacheR/cacheW 四段，渠道色描边 */
function StackedTokenBar({
  provider,
  agg,
  max,
  title,
}: {
  provider: string;
  agg: DailyProviderAgg;
  max: number;
  title: string;
}) {
  const total = agg.totalTokens;
  const heightPct = Math.max(2, (total / (max || 1)) * 100);
  const segments = [
    { value: agg.inputTokens, color: CHART_COLORS.input },
    { value: agg.outputTokens, color: CHART_COLORS.output },
    { value: agg.cacheReadTokens, color: CHART_COLORS.cacheRead },
    { value: agg.cacheWriteTokens, color: CHART_COLORS.cacheWrite },
  ];
  return (
    <div
      title={title}
      style={{ width: 14, height: "100%", display: "flex", alignItems: "flex-end", cursor: "pointer" }}
    >
      <div
        style={{
          width: "100%",
          height: `${heightPct}%`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          borderRadius: 2,
          overflow: "hidden",
          border: `1px solid ${providerColor(provider)}`,
          minHeight: heightPct > 0 ? 3 : 0,
        }}
      >
        {segments.map((s, i) => (
          <div
            key={i}
            style={{
              width: "100%",
              height: `${(s.value / (total || 1)) * 100}%`,
              background: s.color,
              minHeight: s.value > 0 ? 2 : 0,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function thStyle(): CSSProperties {
  return { padding: "8px 12px", textAlign: "left", whiteSpace: "nowrap" };
}
function tdStyle(): CSSProperties {
  return { padding: "7px 12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 };
}
function btnStyle(color: string): CSSProperties {
  return {
    padding: "7px 14px",
    borderRadius: 6,
    border: "none",
    background: color,
    color: "#fff",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
  };
}
function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── 设置视图 ──

interface SettingsViewModel {
  id: string;
  usageUsd: number;
  rate: number;
  peakRate?: number;
  inPrice: number;
  outPrice: number;
  crPrice: number;
  cwPrice: number;
}

interface ModelMetaEdit {
  usage?: string;
  rate?: string;
  peakRate?: string;
}

function SettingsView({
  provider,
  providers,
  models,
  storePrices,
  modelEdits,
  syncBusy,
  monthlyQuotaUsd,
  payAsYouGo,
  unit,
  providerUnitInput,
  onProviderChange,
  onQuotaChange,
  onPaygChange,
  onUnitChange,
  onSaveProviderConfig,
  onQuotaInputReset,
  onEditChange,
  onSync,
  onSaveModel,
}: {
  provider: string;
  providers: string[];
  models: SettingsViewModel[];
  storePrices: Record<string, Record<string, { in: number; out: number; cr: number; cw: number; name?: string }>>;
  modelEdits: Record<string, ModelMetaEdit>;
  syncBusy: boolean;
  monthlyQuotaUsd: number;
  payAsYouGo: boolean;
  unit: "usd" | "count";
  providerUnitInput: "usd" | "count";
  onProviderChange: (p: string) => void;
  onQuotaChange: (v: string) => void;
  onPaygChange: (v: boolean) => void;
  onUnitChange: (u: "usd" | "count") => void;
  onSaveProviderConfig: () => void;
  onQuotaInputReset: (quota: number | undefined, payg: boolean | undefined, unit: "usd" | "count" | undefined) => void;
  onEditChange: (modelId: string, field: keyof ModelMetaEdit, value: string) => void;
  onSync: () => void;
  onSaveModel: (modelId: string) => void;
}) {
  const storeFor = storePrices[provider] ?? {};
  const allModelIds = new Set([
    ...models.map((m) => m.id),
    ...Object.keys(storeFor),
  ]);
  const rows = Array.from(allModelIds).sort((a, b) => a.localeCompare(b));

  return (
    <div>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 18px", marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>模型倍率 / 套餐额度设置</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.6 }}>
          价格（输入/输出/缓存读/缓存写）自动从 pi 传递的 models-store.json 获取，点「同步 pi 价格」更新；
          倍率与模型额度 pi 无法获取，需手动填写。<br />
          渠道总额度 = 套餐月池（如 opencode-go $60）；模型额度 = 该模型对应可用额度（如 $30 → 倍率 = 60/30 = 2，消耗 $1 扣 $2 月额度）。倍率自动 = 渠道总额度 / 模型额度。
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={provider}
            onChange={(e) => {
              onProviderChange(e.target.value);
              onQuotaInputReset(undefined, undefined, undefined);
            }}
            style={{ height: 32, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }}
          >
            {(providers.length ? providers : ["opencode-go"]).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            value={providerUnitInput}
            onChange={(e) => onUnitChange((e.target.value as "usd" | "count"))}
            style={{ height: 32, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }}
          >
            <option value="usd">计费单位：美元 $</option>
            <option value="count">计费单位：调用次数</option>
          </select>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {providerUnitInput === "count" ? "渠道总额度（次/月）" : "渠道总额度 $"}
          </span>
          <input
            type="number"
            step="1"
            min="1"
            defaultValue={monthlyQuotaUsd}
            key={`quota-${provider}-${monthlyQuotaUsd}`}
            onChange={(e) => onQuotaChange(e.target.value)}
            style={{ width: 80, height: 32, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, textAlign: "right" }}
          />
          {providerUnitInput !== "count" && (
            <label style={{ fontSize: 12, color: "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={payAsYouGo}
                key={`payg-${provider}-${String(payAsYouGo)}`}
                onChange={(e) => onPaygChange(e.target.checked)}
                style={{ width: 14, height: 14 }}
              />
              按量计费（无月池，不显示百分比）
            </label>
          )}
          <button onClick={onSaveProviderConfig} style={btnStyle("#6366f1")}>保存渠道配置</button>
          <button onClick={onSync} disabled={syncBusy} style={{ ...btnStyle("var(--accent)"), opacity: syncBusy ? 0.6 : 1 }}>
            {syncBusy ? "同步中…" : "🔄 同步 pi 价格 + 刷新模型列表"}
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          当前渠道：<b style={{ color: providerColor(provider) }}>{provider}</b> · 总额度 {monthlyQuotaUsd}{providerUnitInput === "count" ? " 次" : " $"} ·
          {providerUnitInput === "count" ? "按调用次数计费" : payAsYouGo ? "按量计费（无百分比）" : "订阅月池"}
        </div>
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: "rgba(120,120,120,0.08)", color: "var(--text-dim)", textAlign: "left" }}>
              <th style={thStyle()}>模型 ID</th>
              <th style={thStyle()}>输入 $/M</th>
              <th style={thStyle()}>输出 $/M</th>
              <th style={thStyle()}>缓存读</th>
              <th style={thStyle()}>缓存写</th>
              <th style={thStyle()}>模型额度 $（倍率=总额度/此值）</th>
              <th style={thStyle()}>倍率</th>
              <th style={thStyle()}>高峰倍率</th>
              <th style={thStyle()}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((id) => {
              const m = models.find((x) => x.id === id);
              const sp = storeFor[id];
              const edit = modelEdits[id] ?? {};
              const inPrice = m?.inPrice ?? sp?.in ?? 0;
              const outPrice = m?.outPrice ?? sp?.out ?? 0;
              const crPrice = m?.crPrice ?? sp?.cr ?? 0;
              const cwPrice = m?.cwPrice ?? sp?.cw ?? 0;
              const isNew = !m && !!sp; // 在 pi 目录里但模型表还没有（点同步后变 added）
              const modelUsage = edit.usage !== undefined ? parseFloat(edit.usage) : (m?.usageUsd ?? 0);
              // 倍率自动 = 渠道总额度 / 模型额度（模型额度 0 时回退手动 rate）
              const autoRate = modelUsage > 0 && monthlyQuotaUsd > 0
                ? monthlyQuotaUsd / modelUsage
                : (m?.rate ?? 1);
              const rateShown = edit.rate !== undefined ? edit.rate : String(autoRate === m?.rate ? m?.rate : autoRate);
              return (
                <tr key={id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={tdStyle()}>
                    <span style={{ color: providerColor(provider), marginRight: 2 }}>[{provider}]</span>
                    {id}
                    {isNew && <span style={{ color: "#f59e0b", fontSize: 10, marginLeft: 4 }}>新</span>}
                  </td>
                  <td style={tdStyle()}>{inPrice}</td>
                  <td style={tdStyle()}>{outPrice}</td>
                  <td style={tdStyle()}>{crPrice}</td>
                  <td style={tdStyle()}>{cwPrice}</td>
                  <td style={tdStyle()}>
                    <input
                      type="number"
                      step="0.1"
                      value={edit.usage ?? m?.usageUsd ?? ""}
                      placeholder="额度$"
                      onChange={(e) => onEditChange(id, "usage", e.target.value)}
                      style={inputStyle()}
                    />
                  </td>
                  <td style={tdStyle()}>
                    <input
                      type="number"
                      step="0.1"
                      value={rateShown}
                      placeholder="自动"
                      onChange={(e) => onEditChange(id, "rate", e.target.value)}
                      style={inputStyle()}
                    />
                  </td>
                  <td style={tdStyle()}>
                    <input
                      type="number"
                      step="0.1"
                      value={edit.peakRate ?? m?.peakRate ?? ""}
                      placeholder="—"
                      onChange={(e) => onEditChange(id, "peakRate", e.target.value)}
                      style={inputStyle()}
                    />
                  </td>
                  <td style={tdStyle()}>
                    {(edit.usage !== undefined || edit.rate !== undefined || edit.peakRate !== undefined) && (
                      <button onClick={() => onSaveModel(id)} style={{ ...btnStyle("var(--accent)"), fontSize: 10, padding: "4px 10px" }}>保存</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={9} style={{ ...tdStyle(), textAlign: "center", color: "var(--text-dim)", padding: 20 }}>无模型数据：先点「同步 pi 价格 + 刷新模型列表」</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function inputStyle(): CSSProperties {
  return {
    width: 64,
    height: 26,
    padding: "0 6px",
    border: "1px solid var(--border)",
    borderRadius: 4,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontSize: 11,
    textAlign: "right",
  };
}