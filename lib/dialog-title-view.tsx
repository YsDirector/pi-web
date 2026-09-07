import type { ReactNode } from "react";
import { splitDialogTitleCode } from "@/lib/dialog-title";

/**
 * 渲染弹窗标题：识别 ```sh / ```bash 代码围栏，把围栏内容渲染为高亮代码块
 * （红色边框 + 红色底纹，提示风险命令），其余文本保持 pre-wrap 多行。
 */
export function renderDialogTitle(title: string): ReactNode {
  const segments = splitDialogTitleCode(title);
  if (segments.length === 1 && !segments[0].isCode) return title;
  return segments.map((seg, i) => {
    if (seg.isCode) {
      return (
        <pre
          key={i}
          style={{
            margin: "6px 0",
            padding: "8px 10px",
            borderRadius: 6,
            background: "rgba(239,68,68,0.10)",
            border: "1px solid rgba(239,68,68,0.35)",
            borderLeft: "3px solid #ef4444",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            overflowX: "auto",
            color: "var(--text)",
          }}
        >
          {seg.text}
        </pre>
      );
    }
    return (
      <span key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {seg.text}
      </span>
    );
  });
}
