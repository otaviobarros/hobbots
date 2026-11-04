import { CLEAR_LINE, visible } from "./ansi.ts";

/**
 * How a terminal that shows `shown` moves to `next` (#908). A terminal only appends, so a record
 * that grew is written from where it ended; one whose last line changed, such as a running
 * command's clock, has that line cleared and written again; anything else is written afresh.
 */
export type TerminalWrite =
  | { readonly kind: "none" }
  | { readonly kind: "append"; readonly data: string }
  | { readonly kind: "reset"; readonly data: string };

const sharedLength = (a: string, b: string): number => {
  const most = Math.min(a.length, b.length);
  let at = 0;
  while (at < most && a.charCodeAt(at) === b.charCodeAt(at)) at++;
  return at;
};

/**
 * The write that takes the terminal from `shown` to `next`. `columns` is its width: a last line as
 * wide as it wrapped onto more than one row, which clearing one row would not remove, so the
 * terminal starts again.
 */
export const terminalWrite = (shown: string, next: string, columns: number): TerminalWrite => {
  if (shown === next) return { kind: "none" };
  const shared = sharedLength(shown, next);
  if (shared === shown.length) return { kind: "append", data: next.slice(shared) };
  const lineStart = shown.lastIndexOf("\n") + 1;
  const lastLine = shown.slice(lineStart);
  if (shared >= lineStart && visible(lastLine).length < columns) {
    return { kind: "append", data: CLEAR_LINE + next.slice(lineStart) };
  }
  return { kind: "reset", data: next };
};
