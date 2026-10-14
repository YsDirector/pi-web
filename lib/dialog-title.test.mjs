import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  splitDialogTitle,
  splitDialogTitleCode,
} = await jiti.import("./dialog-title.ts");
const { renderDialogTitle } = await jiti.import("./dialog-title-view.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const React = await jiti.import("react");

// CodeBlock reads the UI language, so the real provider has to be in the tree.
const renderWithI18n = (node) =>
  renderToStaticMarkup(React.createElement(I18nProvider, null, node));

test("splitDialogTitle keeps a one-line title entirely in the head", () => {
  assert.deepEqual(splitDialogTitle("Approve command"), {
    head: "Approve command",
    rest: "",
  });
});

test("splitDialogTitle splits on the first newline only", () => {
  assert.deepEqual(splitDialogTitle("Run this\ncommand here\nmore"), {
    head: "Run this",
    rest: "command here\nmore",
  });
});

test("splitDialogTitle keeps a blank title intact", () => {
  assert.deepEqual(splitDialogTitle(""), { head: "", rest: "" });
});

test("splitDialogTitleCode leaves text with no code fence as a single text segment", () => {
  assert.deepEqual(splitDialogTitleCode("Approve command"), [
    { text: "Approve command", isCode: false },
  ]);
});

test("splitDialogTitleCode highlights a ```bash code fence", () => {
  const segments = splitDialogTitleCode("Confirm running:\n```bash\nrm -rf /\n```");
  assert.deepEqual(segments, [
    { text: "Confirm running:", isCode: false },
    { text: "rm -rf /", isCode: true },
  ]);
});

test("splitDialogTitleCode keeps the blank line that precedes a fence", () => {
  const segments = splitDialogTitleCode(
    "Current agent requested bash command:\n\n```sh\ndocker system prune -a\n```",
  );
  assert.deepEqual(segments, [
    { text: "Current agent requested bash command:\n", isCode: false },
    { text: "docker system prune -a", isCode: true },
  ]);
});

test("splitDialogTitleCode only treats sh/bash as a highlighted fence", () => {
  // A ```python fence is highlighted nowhere: Pi's TUI shows the title verbatim,
  // and highlighting means "this is the command you are approving".
  assert.deepEqual(splitDialogTitleCode("Run:\n```python\nprint(1)\n```"), [
    { text: "Run:\n```python\nprint(1)\n```", isCode: false },
  ]);
});

test("splitDialogTitleCode leaves a bare ``` fence as literal text", () => {
  assert.deepEqual(splitDialogTitleCode("Run:\n```\nplain\n```"), [
    { text: "Run:\n```\nplain\n```", isCode: false },
  ]);
});

test("splitDialogTitleCode drops blank padding before the closing fence", () => {
  const segments = splitDialogTitleCode("Run:\n```sh\nrm -rf /\n\n```");
  assert.deepEqual(segments[1], { text: "rm -rf /", isCode: true });
});

test("splitDialogTitleCode runs an unclosed fence to the end of the title", () => {
  assert.deepEqual(splitDialogTitleCode("Run:\n```sh\nrm -rf /"), [
    { text: "Run:", isCode: false },
    { text: "rm -rf /", isCode: true },
  ]);
});

test("splitDialogTitleCode tolerates a CRLF title and indented fences", () => {
  assert.deepEqual(splitDialogTitleCode("Run:\r\n  ```bash\r\nrm -rf /\r\n  ```"), [
    { text: "Run:", isCode: false },
    { text: "rm -rf /", isCode: true },
  ]);
});

test("splitDialogTitleCode highlights multiple consecutive code fences", () => {
  const segments = splitDialogTitleCode("A\n```sh\na\n```\nB\n```bash\nb\n```\nC");
  assert.deepEqual(
    segments.map((s) => s.isCode),
    [false, true, false, true, false],
  );
});

test("renderDialogTitle renders sh fences with the shared chat code block", () => {
  const markup = renderWithI18n(renderDialogTitle("Run this:\n```sh\nrm -rf /\n```"));
  assert.match(markup, /<div class="markdown-code-block">/);
  assert.match(markup, /<span class="markdown-code-lang">sh<\/span>/);
  // Prism may be deferred until the language loader is ready; the shared block
  // must still expose the complete command text in its plain fallback.
  assert.match(markup, /rm -rf \//);
  assert.match(markup, /<span[^>]*white-space:pre-wrap[^>]*>Run this:<\/span>/);
  // No bespoke "danger" styling: the dialog reuses the chat code block as-is.
  assert.doesNotMatch(markup, /#ef4444|rgba\(239,68,68/);
});

test("renderDialogTitle returns plain text untouched when there is no sh fence", () => {
  // A single text segment is returned as the raw string, so nothing is re-wrapped.
  const markup = renderWithI18n(renderDialogTitle("```python\nprint(1)\n```"));
  assert.doesNotMatch(markup, /markdown-code-block/);
  assert.match(markup, /```python/);
});
