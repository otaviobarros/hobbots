import { Schema } from "effect";

/**
 * What a tool step shows of what its call printed. Short output is shown whole, in `head`. Past the
 * limit the step keeps the start and the end, where a command's setup and its error usually are,
 * and says how much was left out between them. Secrets are redacted before the output is cut, so a
 * secret that crosses a cut is still found.
 */
export const ToolOutput = Schema.Struct({
  /** The whole output when it fits, else its first bytes. */
  head: Schema.String,
  /** Empty when the output fits; else its last bytes. */
  tail: Schema.String,
  /** UTF-8 bytes left out between `head` and `tail`; 0 when the output is shown whole. */
  omittedBytes: Schema.Number,
  /** UTF-8 bytes of the whole output, after redaction. */
  totalBytes: Schema.Number,
  /** Whether the hub kept the whole output in a log the user can open from the step. */
  logged: Schema.Boolean,
});
export type ToolOutput = typeof ToolOutput.Type;

/** How many bytes a tool step keeps from each end of a long output. */
export const TOOL_OUTPUT_EDGE_BYTES = 8 * 1024;

/** How many bytes UTF-8 takes for the character that starts with code point `point`. */
const utf8Length = (point: number) => (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);

/** How many bytes `text` takes in UTF-8. */
const utf8Bytes = (text: string) => {
  let bytes = 0;
  for (const character of text) bytes += utf8Length(character.codePointAt(0) ?? 0);
  return bytes;
};

/** The longest start of `characters` that fits in `edge` bytes. */
const fitting = (characters: ReadonlyArray<string>, edge: number) => {
  let bytes = 0;
  let count = 0;
  for (const character of characters) {
    bytes += utf8Length(character.codePointAt(0) ?? 0);
    if (bytes > edge) break;
    count++;
  }
  return characters.slice(0, count).join("");
};

/**
 * The start and end of `text`, `edge` bytes from each, or all of it when it fits in twice that.
 * Sizes count UTF-8 bytes. Cuts fall between characters, and at a line break when the part has
 * one, so neither part shows half a character or half a line.
 */
export const previewToolOutput = (text: string, edge: number = TOOL_OUTPUT_EDGE_BYTES): Omit<ToolOutput, "logged"> => {
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= edge * 2) return { head: text, tail: "", omittedBytes: 0, totalBytes };
  const characters = Array.from(text);
  let head = fitting(characters, edge);
  let tail = Array.from(fitting([...characters].reverse(), edge))
    .reverse()
    .join("");
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > 0) head = head.slice(0, headBreak + 1);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak !== -1 && tailBreak < tail.length - 1) tail = tail.slice(tailBreak + 1);
  return { head, tail, omittedBytes: totalBytes - utf8Bytes(head) - utf8Bytes(tail), totalBytes };
};
