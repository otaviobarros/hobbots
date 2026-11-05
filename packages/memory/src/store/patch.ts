/**
 * Applies a line diff ai-memory answered to the text it was taken from (ADR 028): how a restore
 * rebuilds an earlier version from the latest one, so it can write it back conditionally.
 */

/** A hunk of a line diff: where it starts in the old text (from 1), how many old lines it covers, and its lines. */
export interface Hunk {
  readonly old_start: number;
  readonly old_len: number;
  readonly lines: ReadonlyArray<{ readonly op: string; readonly text: string }>;
}

/**
 * `text` with `hunks` applied, in order, or null when a hunk does not match the text: a context or
 * removed line that is not there, or an op it does not know. A hunk that covers no old lines inserts
 * after its `old_start` line, as unified diffs do.
 */
export const applyHunks = (text: string, hunks: ReadonlyArray<Hunk>): string | null => {
  const old = text.split("\n");
  const out: Array<string> = [];
  let at = 0;
  for (const hunk of hunks) {
    const start = hunk.old_len === 0 ? hunk.old_start : hunk.old_start - 1;
    if (start < at || start > old.length) return null;
    out.push(...old.slice(at, start));
    at = start;
    for (const line of hunk.lines) {
      if (line.op === "+") {
        out.push(line.text);
      } else if (line.op === " " || line.op === "-") {
        if (old[at] !== line.text) return null;
        if (line.op === " ") out.push(line.text);
        at += 1;
      } else {
        return null;
      }
    }
  }
  out.push(...old.slice(at));
  return out.join("\n");
};
