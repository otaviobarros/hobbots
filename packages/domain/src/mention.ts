import { type Actor, sameActor } from "./actor.ts";

/**
 * A hob or a person a message can @mention (ADR 039, Who answers): the actor and the name people
 * write after `@`. The roster holds every hob and person of the hub, not only a thread's members,
 * so a mention of a hob outside the camp is still found, and refused, rather than read as text.
 */
export interface Mentionable {
  readonly actor: Actor;
  readonly name: string;
}

/** Letters, digits and `_`: a mention never starts right after one, nor stops right before one. */
const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** Blanks `from` to `to` of the characters, line breaks kept, so offsets still match the text. */
const blank = (chars: Array<string>, from: number, to: number): void => {
  for (let at = from; at < to; at++) if (chars[at] !== "\n") chars[at] = " ";
};

/** How many characters from `at` on pass `test`. */
const runLengthOf = (text: string, at: number, test: (char: string) => boolean): number => {
  let end = at;
  while (end < text.length && test(text[end] ?? "")) end++;
  return end - at;
};

/** How many times `char` repeats from `at` on. */
const runLength = (text: string, at: number, char: string): number => runLengthOf(text, at, (c) => c === char);

/** Whether a list item's marker starts at `at`: `-`, `*` or `+`, or up to nine digits and `.` or `)`. */
const listMarkerEnd = (line: string, at: number): number | null => {
  const char = line[at];
  if (char === "-" || char === "*" || char === "+") return at + 1;
  const digits = runLengthOf(line, at, (c) => c >= "0" && c <= "9");
  const after = line[at + digits];
  return digits > 0 && digits <= 9 && (after === "." || after === ")") ? at + digits + 1 : null;
};

/**
 * Where a line's text starts once its containers are passed (CommonMark 5): any indentation, each
 * block quote's `>`, and each list item's marker followed by a space or a tab. A fence inside a quote
 * or a list item is then read as a fence, at any depth.
 */
const contentStart = (line: string): number => {
  let at = runLengthOf(line, 0, (c) => c === " " || c === "\t");
  for (;;) {
    if (line[at] === ">") {
      at += 1;
    } else {
      const end = listMarkerEnd(line, at);
      if (end === null || (line[end] !== " " && line[end] !== "\t")) return at;
      at = end;
    }
    at += runLengthOf(line, at, (c) => c === " " || c === "\t");
  }
};

/**
 * A fence line's marker (CommonMark 4.5): three or more ` or ~ where the line's text starts. Read at
 * any indentation, so an indented code block's line of backticks also hides what follows it: a
 * missed mention, never a false one.
 */
const fenceOf = (line: string): { readonly char: string; readonly length: number; readonly rest: string } | null => {
  const start = contentStart(line);
  const char = line[start];
  if (char !== "`" && char !== "~") return null;
  const length = runLength(line, start, char);
  return length < 3 ? null : { char, length, rest: line.slice(start + length) };
};

/** Whether `line` closes a fence opened with `open`: the same character, at least as many, nothing after. */
const closes = (line: string, open: { readonly char: string; readonly length: number }): boolean => {
  const fence = fenceOf(line);
  return fence !== null && fence.char === open.char && fence.length >= open.length && fence.rest.trim() === "";
};

/**
 * The text with its fenced code blocks blanked out (CommonMark 4.5): from a fence line to the line
 * that closes it, or to the end when none does. A backtick fence's info string has no backtick.
 */
const withoutFences = (text: string): string => {
  const out = text.split("");
  let open: { readonly char: string; readonly length: number; readonly from: number } | null = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const end = at + line.length;
    if (open !== null) {
      if (closes(line, open)) {
        blank(out, open.from, end);
        open = null;
      }
    } else {
      const fence = fenceOf(line);
      if (fence !== null && !(fence.char === "`" && fence.rest.includes("`"))) open = { ...fence, from: at };
    }
    at = end + 1;
  }
  if (open !== null) blank(out, open.from, text.length);
  return out.join("");
};

/**
 * The text with its code spans blanked out (CommonMark 6.1): a run of backticks opens a span that
 * the next run of exactly as many closes, across lines too; a run nothing closes is plain text.
 * Runs are grouped by length, and each group is read forward once, so it stays linear.
 */
const withoutSpans = (text: string): string => {
  const runs: Array<{ readonly at: number; readonly length: number }> = [];
  const byLength = new Map<number, Array<number>>();
  for (let at = text.indexOf("`"); at !== -1; at = text.indexOf("`", at)) {
    const length = runLength(text, at, "`");
    const same = byLength.get(length);
    if (same === undefined) byLength.set(length, [runs.length]);
    else same.push(runs.length);
    runs.push({ at, length });
    at += length;
  }
  // For each length, how far along its runs the search has moved.
  const read = new Map<number, number>();
  const out = text.split("");
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    if (open === undefined) continue;
    const same = byLength.get(open.length) ?? [];
    let k = read.get(open.length) ?? 0;
    while (k < same.length && (same[k] ?? 0) <= i) k++;
    read.set(open.length, k);
    const j = same[k];
    const close = j === undefined ? undefined : runs[j];
    if (j === undefined || close === undefined) continue;
    blank(out, open.at, close.at + close.length);
    i = j;
  }
  return out.join("");
};

/**
 * The text with its Markdown code blanked out, so `@Pip` in code is never a mention: fenced blocks
 * with ``` or ~~~, then code spans of any number of backticks. Each character keeps its place, so
 * offsets still match the text. No pattern that can backtrack (STD-SEC-005).
 */
const withoutCode = (text: string): string => withoutSpans(withoutFences(text));

/**
 * The roster's names, longest first, so `@Pip Two` finds "Pip Two" before "Pip", each with the form
 * it is compared in. Blank names are left out.
 */
const byLongestName = (roster: ReadonlyArray<Mentionable>) =>
  roster
    .map((entry) => {
      const name = entry.name.trim();
      return { actor: entry.actor, length: name.length, folded: name.toLowerCase() };
    })
    .filter((entry) => entry.length > 0)
    .sort((a, b) => b.length - a.length);

/**
 * The roster entry named right after the `@` at `at`, or undefined when no name stands there whole.
 * Each name is cut from the text at its own length before the case is folded, since folding can
 * change a string's length.
 */
const namedAt = (text: string, at: number, names: ReturnType<typeof byLongestName>) =>
  names.find(
    (entry) =>
      text.slice(at + 1, at + 1 + entry.length).toLowerCase() === entry.folded &&
      !isWordChar(text[at + 1 + entry.length]),
  );

/**
 * The hobs and people a message's text @mentions (ADR 039, Who answers), in the order they are first
 * mentioned, each once. Parsed once, when the message is stored, into `Message.mentions`, so who
 * answers and who is told read the same list.
 *
 * A mention is `@` and a roster name, matched without regard to case, where the `@` starts the text
 * or follows something other than a letter or a digit (so `ana@pip.dev` mentions nobody) and the name
 * ends at something other than a letter or a digit. Of two names that both fit, the longer wins.
 * Markdown code mentions nobody: fenced blocks, in quotes and list items too, and code spans, as
 * CommonMark reads them.
 *
 * `after` reads only the mentions whose name ends past that offset, for text that grew after its
 * start was parsed, such as a reply continued with Continue: what that start mentioned was decided
 * then, against the roster of then, and is never read again. The whole text still decides what is code.
 */
export const mentionsIn = (text: string, roster: ReadonlyArray<Mentionable>, after = 0): ReadonlyArray<Actor> => {
  if (!text.includes("@")) return [];
  const names = byLongestName(roster);
  const plain = withoutCode(text);
  const found: Array<Actor> = [];
  for (let at = plain.indexOf("@"); at !== -1; at = plain.indexOf("@", at + 1)) {
    if (isWordChar(plain[at - 1])) continue;
    const entry = namedAt(plain, at, names);
    if (entry === undefined || at + 1 + entry.length <= after) continue;
    if (!found.some((seen) => sameActor(seen, entry.actor))) found.push(entry.actor);
  }
  return found;
};

/** Whether the message mentions the actor: a mention of you, which is counted for you alone. */
export const mentions = (message: { readonly mentions: ReadonlyArray<Actor> }, actor: Actor): boolean =>
  message.mentions.some((mentioned) => sameActor(mentioned, actor));
