import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const messageViewSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const messageDisplaySource = await readFile(new URL("../lib/message-display.ts", import.meta.url), "utf8");
const cardSource = await readFile(new URL("./BackgroundJobMessage.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { BackgroundJobMessageView } = await jiti.import("./BackgroundJobMessage.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const React = await jiti.import("react");

const delivery = [
  "bash> [后台任务 #3 完成] exit=0 · 用时 8s · pid=38973",
  "命令: npm test",
  "输出（末尾 2 行 / 共 25 行，完整日志 /tmp/pi-bg/s/3.log）:",
  "```",
  "✔ 1061 passed",
  "```",
].join("\n");

function render(message) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(BackgroundJobMessageView, { message })),
  );
}

test("routes bash-bg custom messages to the background-job card", () => {
  assert.match(messageViewSource, /import \{ BackgroundJobMessageView \} from "\.\/BackgroundJobMessage"/);
  assert.match(
    messageViewSource,
    /customType === BACKGROUND_JOB_CUSTOM_TYPE\) \{\s*return <BackgroundJobMessageView message=\{message as CustomMessage\}/,
  );
});

test("treats a background-job receipt as its own message group", () => {
  // Without this the receipt is folded into the previous turn's process details.
  assert.match(messageDisplaySource, /export const BACKGROUND_JOB_CUSTOM_TYPE = "bash-bg"/);
  assert.match(
    messageDisplaySource,
    /message\.customType === "compaction" \|\| message\.customType === BACKGROUND_JOB_CUSTOM_TYPE/,
  );
});

test("collapsed card shows the type label, status summary and no body", () => {
  const markup = render({
    role: "custom",
    customType: "bash-bg",
    display: true,
    content: delivery,
    details: { jobs: [{ id: 3, status: "done", exitCode: 0, logPath: "/tmp/pi-bg/s/3.log" }] },
  });

  // Same header shape as a tool card: mono bold 11px label, gray single-line summary.
  assert.match(markup, /<span style="color:#16a34a;font-family:var\(--font-mono\);font-weight:600;font-size:11px[^"]*">bash-bg<\/span>/);
  assert.match(markup, /\[后台任务 #3 完成\] exit=0 · 用时 8s · pid=38973/);
  // The `bash>` prefix stays in the message, not in the header.
  assert.doesNotMatch(markup, /bash-bg<\/span>.*?bash&gt; \[后台任务/s);
  // Collapsed by default: the body (markdown pipeline) is not rendered.
  assert.doesNotMatch(markup, /markdown-body/);
  assert.doesNotMatch(markup, /1061 passed/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(cardSource, /const \[expanded, setExpanded\] = useState\(false\)/);
});

test("failed jobs use the tool-card error colors", () => {
  const markup = render({
    role: "custom",
    customType: "bash-bg",
    display: true,
    content: "bash> [后台任务 #4 失败] exit=1 · 用时 2s · pid=1\n命令: npm test",
    details: { jobs: [{ id: 4, status: "failed", exitCode: 1 }] },
  });

  assert.match(markup, /border:1px solid rgba\(248,113,113,0\.45\)/);
  assert.match(markup, /color:#f87171;font-family:var\(--font-mono\);font-weight:600/);
});

test("old receipts without job details still render as a successful card", () => {
  const markup = render({ role: "custom", customType: "bash-bg", display: true, content: delivery });
  assert.match(markup, /border:1px solid rgba\(34,197,94,0\.25\)/);
  assert.match(markup, /bash-bg<\/span>/);
});
