"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";

interface UsageApiResponse {
  ok: boolean;
  state: {
    enabled: boolean;
    periodStartTs: number;
    periodStartIso: string | null;
    baselineQuotaPct: number;
  };
  quota: {
    monthlyQuotaUsd: number;
    totalPct: number;
    deltaPct: number;
    costUsd: number;
    count: number;
    tokens: { input: number; output: number; total: number };
  };
  byModel: Array<{
    model: string;
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
  models: Array<{ id: string; usageUsd: number; rate: number; peakRate?: number }>;
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

export default function UsagePage() {
  const [data, setData] = useState<UsageApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingBaseline, setEditingBaseline] = useState(false);
  const [baselineInput, setBaselineInput] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
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
    load();
  }, [load]);

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
        await load();
        setStatusMsg("保存成功");
        setTimeout(() => setStatusMsg(null), 2000);
      } catch (e) {
        setStatusMsg(e instanceof Error ? `失败: ${e.message}` : "保存失败");
      }
    },
    [load],
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

  if (loading) {
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
        <button
          onClick={load}
          style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer" }}
        >
          重试
        </button>
      </div>
    );
  }

  const { quota, state, byModel, peakNow, models } = data;
  const sortedModels = [...byModel].sort((a, b) => b.quotaPct - a.quotaPct);
  const modelMetaById = new Map(models.map((m) => [m.id, m]));

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 20px 60px", fontFamily: "var(--font-noto-mono), monospace", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
          📊 OpenCode Go 月额度看板
        </h1>
        <a href="/" style={{ color: "var(--accent)", textDecoration: "none", fontSize: 12 }}>
          ← 返回聊天
        </a>
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 12, marginBottom: 20 }}>
        {peakNow
          ? "当前为高峰时段（deepseek-v4 价格 ×2，倍率翻倍）"
          : "当前为空闲时段（deepseek-v4 基础倍率）"}
        {" · "}月统计自{" "}
        {state.periodStartIso
          ? new Date(state.periodStartIso).toLocaleString("zh-CN")
          : "账本起始（未手动重置）"}
      </div>

      {/* 总消耗卡片 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <MetricCard label="月额度消耗" value={`${quota.totalPct.toFixed(3)}%`} sub={`基线 ${state.baselineQuotaPct.toFixed(2)}% + 新增 ${quota.deltaPct.toFixed(3)}%`} />
        <MetricCard label="当前成本（账本）" value={fmtUsd(quota.costUsd)} sub={`${quota.count} 次请求`} />
        <MetricCard label="Tokens" value={fmtTokens(quota.tokens.total)} sub={`in ${fmtTokens(quota.tokens.input)} · out ${fmtTokens(quota.tokens.output)}`} />
      </div>

      {/* 进度条 */}
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 18, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>月池 {fmtUsd(quota.monthlyQuotaUsd)}</span>
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
        </div>
      </div>

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

      {/* 按模型明细 */}
      <h2 style={{ fontSize: 14, fontWeight: 700, margin: "28px 0 10px" }}>按模型（本次周期新增）</h2>
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "rgba(120,120,120,0.08)", color: "var(--text-dim)", textAlign: "left" }}>
              <th style={thStyle}>模型</th>
              <th style={thStyle}>请求</th>
              <th style={thStyle}>Tokens</th>
              <th style={thStyle}>美元</th>
              <th style={thStyle}>额度%</th>
              <th style={thStyle}>倍率</th>
            </tr>
          </thead>
          <tbody>
            {sortedModels.map((m) => {
              const meta = modelMetaById.get(m.model);
              return (
                <tr key={m.model} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={tdStyle}>
                    {m.model}
                    {meta && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>（月额度 ${meta.usageUsd}）</span>}
                  </td>
                  <td style={tdStyle}>{m.count}</td>
                  <td style={tdStyle}>{fmtTokens(m.totalTokens)}</td>
                  <td style={tdStyle}>{fmtUsd(m.costUsd)}</td>
                  <td style={tdStyle}>{m.quotaPct.toFixed(4)}%</td>
                  <td style={tdStyle}>
                    {m.rate}
                    {m.peakRate && m.peakRate !== m.rate && <span style={{ color: "#f59e0b" }}>（高峰 {m.peakRate}）</span>}
                  </td>
                </tr>
              );
            })}
            {sortedModels.length === 0 && (
              <tr><td colSpan={6} style={{ ...tdStyle, textAlign: "center", color: "var(--text-dim)" }}>暂无记账数据（扩展加载后产生请求才记录）</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 模型倍率参考表 */}
      <h2 style={{ fontSize: 14, fontWeight: 700, margin: "28px 0 10px" }}>模型倍率表（{models.length} 个）</h2>
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", maxHeight: 340, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--bg-panel)" }}>
            <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
              <th style={thStyle}>模型</th>
              <th style={thStyle}>月额度 $</th>
              <th style={thStyle}>倍率</th>
              <th style={thStyle}>高峰倍率</th>
            </tr>
          </thead>
          <tbody>
            {[...models].sort((a, b) => a.usageUsd - b.usageUsd).map((m) => (
              <tr key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={tdStyle}>{m.id}</td>
                <td style={tdStyle}>{m.usageUsd}</td>
                <td style={tdStyle}>{m.rate}</td>
                <td style={tdStyle}>{m.peakRate ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 最近记账明细 */}
      <h2 style={{ fontSize: 14, fontWeight: 700, margin: "28px 0 10px" }}>最近记录（最近 50 条）</h2>
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", maxHeight: 320, overflowY: "auto", fontSize: 11 }}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {data.ledger.map((e, i) => (
            <li key={i} style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, justifyContent: "space-between" }}>
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