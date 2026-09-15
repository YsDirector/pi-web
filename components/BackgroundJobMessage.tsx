"use client";

import { useMemo, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/hooks/useI18n";
import type { CustomMessage, TextContent } from "@/lib/types";

/**
 * 后台任务回执里 `details.jobs` 的元素（由 bash-bg 扩展写入）。
 * details 不进 LLM 上下文，只用来判断这张卡片的成败配色。
 */
interface BackgroundJobDetail {
  id?: number;
  status?: string;
  exitCode?: number | null;
  logPath?: string;
}

/** 卡片严重度：正常 / 琥珀（超时、被终止）/ 红（真失败） */
type Severity = "ok" | "warning" | "error";

/** 与工具调用卡片同型的配色：标签色 + 边框 + 底纹 */
const SEVERITY_STYLE: Record<Severity, { label: string; border: string; background: string }> = {
  ok: { label: "#16a34a", border: "1px solid rgba(34,197,94,0.25)", background: "rgba(34,197,94,0.04)" },
  warning: { label: "#d97706", border: "1px solid rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.06)" },
  error: { label: "#f87171", border: "1px solid rgba(248,113,113,0.45)", background: "rgba(248,113,113,0.05)" },
};

const SEVERITY_RANK: Record<Severity, number> = { ok: 0, warning: 1, error: 2 };

/**
 * 单个任务的严重度。
 *
 * `done` 且退出码为 0 才算正常；`timeout` / `killed` 是「没跑完」而非「跑错了」，
 * 用琥珀色区分；其余（failed / oversize / lost / 非零退出码）都算真失败。
 */
function jobSeverity(job: BackgroundJobDetail): Severity {
  const badExit = job.exitCode !== undefined && job.exitCode !== null && job.exitCode !== 0;
  if (job.status === undefined || job.status === "done") return badExit ? "error" : "ok";
  if (job.status === "timeout" || job.status === "killed") return "warning";
  return "error";
}

function messageText(content: CustomMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 折叠时显示的一行摘要：取首行、去掉 `bash>` 标签、压成单行。
 * 首行通常是 `bash> [后台任务 #3 完成] exit=0 · 用时 8s · pid=…`。
 */
function summaryLine(text: string): string {
  const firstLine = text.split("\n", 1)[0]?.replace(/^bash>\s*/, "") ?? "";
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized;
}

/**
 * 后台任务（bash-bg）回执卡片。
 *
 * 与工具调用卡片同一套视觉：等宽加粗的类型标签、灰字摘要、右侧箭头折叠——默认收起，
 * 展开后才渲染完整输出（走与聊天相同的 markdown 管线）。配色按严重度分三级：
 * 正常绿、超时/被终止琥珀、真失败红。结果消息在 LLM 语境里仍是一条普通 user 消息
 * （pi 的 convertToLlm 原样转换），这里改变的只是它在 pi-web 里的呈现。
 */
export function BackgroundJobMessageView({ message, cwd, onOpenFile }: {
  message: CustomMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const text = useMemo(() => messageText(message.content), [message.content]);
  const jobs = useMemo(() => {
    const raw = (message.details as { jobs?: unknown } | undefined)?.jobs;
    return Array.isArray(raw) ? (raw as BackgroundJobDetail[]) : [];
  }, [message.details]);
  // 同一批可能合并了多个任务，取最严重的一个决定整卡配色。
  const severity = useMemo(() => jobs.reduce<Severity>((worst, job) => {
    const next = jobSeverity(job);
    return SEVERITY_RANK[next] > SEVERITY_RANK[worst] ? next : worst;
  }, "ok"), [jobs]);
  const palette = SEVERITY_STYLE[severity];
  const summary = summaryLine(text) || t("i18n.noMessage");

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          borderRadius: 7,
          overflow: "hidden",
          fontSize: 12,
          border: palette.border,
          background: palette.background,
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? t("i18n.collapse") : t("i18n.expand")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            minWidth: 0,
            padding: "6px 10px",
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            textAlign: "left",
          }}
        >
          <span style={{ color: palette.label, fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
            {message.customType}
          </span>
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {summary}
          </span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="var(--text-dim)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
          >
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {expanded && (
          <div
            style={{
              padding: "2px 10px 8px",
              borderTop: palette.border,
              background: "var(--bg)",
            }}
          >
            <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>
              {text}
            </MarkdownBody>
          </div>
        )}
      </div>
    </div>
  );
}
