/**
 * Dialog-title rendering helpers for the extension request dialog.
 *
 * A dialog title can be long and may embed a risky command inside a ```sh / ```bash
 * code fence (select/input have no separate message field, so extensions put
 * multi-line text in the title). We split the title into a one-line "head" (pinned
 * in the dialog header) and the remaining "rest" (shown in the scrollable body),
 * and render ```sh / ```bash fences in the rest as highlighted code blocks.
 *
 * Only an explicit `sh` or `bash` opening fence starts a highlighted segment; every
 * other fence (a bare ```, or ```python) stays literal text, because the highlight
 * means "this is a command to approve". Pi's TUI shows the title verbatim, so a
 * client that does not highlight anything still renders the same string.
 */

/** Split a dialog title at its first newline into a one-line head and the rest. */
export function splitDialogTitle(title: string): { head: string; rest: string } {
  const firstNewline = title.indexOf("\n");
  return {
    head: firstNewline === -1 ? title : title.slice(0, firstNewline),
    rest: firstNewline === -1 ? "" : title.slice(firstNewline + 1),
  };
}

export type DialogTitleSegment = { text: string; isCode: boolean };

/** Opening fence: its own line, language must be exactly sh or bash. */
const OPEN_FENCE = /^```(?:sh|bash)$/;
/** Closing fence: its own line, no language tag. */
const CLOSE_FENCE = /^```$/;

/**
 * Split dialog-title text into alternating text / code segments. A ```sh or ```bash
 * fence on its own line toggles into a code segment; all other content is plain text.
 * The first segment is always text, and code segments are the ones that get
 * highlighted. An opening fence with no closing fence runs to the end of the title.
 */
export function splitDialogTitleCode(title: string): DialogTitleSegment[] {
  const segments: DialogTitleSegment[] = [];
  let text: string[] = [];
  let code: string[] | null = null;

  const flushText = () => {
    if (text.length) segments.push({ text: text.join("\n"), isCode: false });
    text = [];
  };
  const flushCode = () => {
    if (code !== null) {
      // Drop the blank line(s) that precede the closing fence so the highlighted
      // code block does not end with a stray blank line.
      segments.push({ text: code.join("\n").replace(/\n+$/, ""), isCode: true });
      code = null;
    }
  };

  for (const line of title.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (code === null && OPEN_FENCE.test(trimmed)) {
      flushText();
      code = [];
      continue;
    }
    if (code !== null && CLOSE_FENCE.test(trimmed)) {
      flushCode();
      continue;
    }
    (code ?? text).push(line);
  }

  if (code !== null) flushCode();
  else flushText();

  return segments.length ? segments : [{ text: title, isCode: false }];
}
