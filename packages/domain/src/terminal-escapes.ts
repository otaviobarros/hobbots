/**
 * Terminal escape sequences in what a command prints. A hob's commands run with color forced on,
 * though they have no terminal, so their output carries the sequences a terminal reads as color,
 * cursor moves and links. The Workbench's terminal keeps them; every plain-text use of the output
 * strips them, so neither a hob nor a plain view ever reads them.
 */

// The ESC character, written as an escape so no pattern holds a control character.
const ESC = "\\u001b";

/**
 * One escape sequence: a control sequence (`ESC [ … m` for color, also cursor moves), one with the
 * 8-bit introducer (0x9b), an operating system command (`ESC ] … BEL` or `ESC ] … ESC \`, such as a
 * link or a window title), a device control or similar string ended by `ESC \`, or a short escape
 * such as `ESC 7`. A control sequence or lone ESC cut off at the end of the text counts too.
 */
const SEQUENCE = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    "\\u009b[0-?]*[ -/]*[@-~]",
    `${ESC}\\][^\\u0007\\u001b]*(?:\\u0007|${ESC}\\\\)`,
    `${ESC}[P^_X][^\\u001b]*${ESC}\\\\`,
    `${ESC}(?:\\[[0-?]*[ -/]*)?$`,
    `${ESC}[ -/]*[0-~]`,
  ].join("|"),
  "g",
);

/** Sequences that carry text of their own, such as a link's address, rather than only a style. */
const CARRIES_TEXT = new RegExp(`^${ESC}[\\]P^_X]`);

/** Whether `text` may hold an escape sequence. */
export const hasEscapes = (text: string): boolean => text.includes("\u001b") || text.includes("\u009b");

/** `text` without its escape sequences: what a terminal would show of it, minus the styling. */
export const stripEscapes = (text: string): string => (hasEscapes(text) ? text.replace(SEQUENCE, "") : text);

/** An escape sequence and where it sits in the text without escapes. */
export interface PlacedEscape {
  /** Its position in `plain`: it came just before the character at this index. */
  readonly at: number;
  readonly code: string;
}

/** Text taken apart into what it says and the escape sequences between. */
export interface EscapedText {
  readonly plain: string;
  /** In the order they came. */
  readonly escapes: ReadonlyArray<PlacedEscape>;
}

/** Takes `text` apart into its plain text and the escape sequences in it. */
export const splitEscapes = (text: string): EscapedText => {
  if (!hasEscapes(text)) return { plain: text, escapes: [] };
  const escapes: Array<PlacedEscape> = [];
  let plain = "";
  let from = 0;
  for (const match of text.matchAll(SEQUENCE)) {
    plain += text.slice(from, match.index);
    escapes.push({ at: plain.length, code: match[0] });
    from = match.index + match[0].length;
  }
  plain += text.slice(from);
  return { plain, escapes };
};

/** Puts text taken apart with `splitEscapes` back together. */
export const joinEscapes = ({ plain, escapes }: EscapedText): string => {
  let text = "";
  let from = 0;
  for (const sequence of escapes) {
    text += plain.slice(from, sequence.at) + sequence.code;
    from = sequence.at;
  }
  return text + plain.slice(from);
};

/** Whether an escape sequence carries text of its own, such as a link's address. */
export const escapeCarriesText = (code: string): boolean => CARRIES_TEXT.test(code);

/** A change to plain text: the characters from `start` to `end` become `text`. */
export interface PlainEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Applies `edits`, in order and not overlapping, to the plain text and keeps every sequence: one
 * before or at an edit's start stays before it, one inside the edited text moves to just after its
 * replacement, so the styles around it still open and close, and one after it moves with the text.
 */
export const editPlain = (text: EscapedText, edits: ReadonlyArray<PlainEdit>): EscapedText => {
  if (edits.length === 0) return text;
  let plain = "";
  let from = 0;
  for (const edit of edits) {
    plain += text.plain.slice(from, edit.start) + edit.text;
    from = edit.end;
  }
  plain += text.plain.slice(from);
  let next = 0;
  let shift = 0;
  const escapes = text.escapes.map((sequence) => {
    while (next < edits.length && (edits[next] as PlainEdit).end <= sequence.at) {
      const done = edits[next] as PlainEdit;
      if (done.end === sequence.at && done.start === sequence.at) break;
      shift += done.text.length - (done.end - done.start);
      next++;
    }
    const edit = edits[next];
    const inside = edit !== undefined && edit.start < sequence.at && sequence.at < edit.end;
    return { at: inside ? edit.start + shift + edit.text.length : sequence.at + shift, code: sequence.code };
  });
  return { plain, escapes };
};
