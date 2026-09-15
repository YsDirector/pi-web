import type { ReactNode } from "react";
import { CodeBlock } from "@/components/MermaidBlock";
import { splitDialogTitleCode } from "@/lib/dialog-title";

/**
 * 渲染弹窗标题：```sh / ```bash 围栏内容交给聊天用的同一个 CodeBlock 渲染
 *（主题变量 + 语法高亮 + 复制按钮），其余文本保持 pre-wrap 多行。
 *
 * 这里只负责「把围栏里的命令显示清楚」，不做「红色 = 危险」的策略判断 ——
 * 危险语义由插件自己写进正文（例如 "Allow this command?"）。
 */
export function renderDialogTitle(title: string): ReactNode {
  const segments = splitDialogTitleCode(title);
  if (segments.length === 1 && !segments[0].isCode) return title;
  return segments.map((seg, i) => {
    if (seg.isCode) {
      return <CodeBlock key={i} code={seg.text} lang="sh" />;
    }
    return (
      <span key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {seg.text}
      </span>
    );
  });
}
