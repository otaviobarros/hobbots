import { Schema } from "effect";
import { MessageId } from "./ids.ts";
import { MessageRole } from "./message.ts";
import { Thread } from "./thread.ts";

/** A piece of a snippet; `match` marks words that matched the search. */
export const SnippetPart = Schema.Struct({
  text: Schema.String,
  match: Schema.Boolean,
});
export type SnippetPart = typeof SnippetPart.Type;

/** A message that matched, with the words around the first match. */
export const MessageMatch = Schema.Struct({
  messageId: MessageId,
  role: MessageRole,
  createdAt: Schema.String,
  snippet: Schema.Array(SnippetPart),
});
export type MessageMatch = typeof MessageMatch.Type;

/** A thread whose title or messages matched; its newest matching messages come first. */
export const SearchHit = Schema.Struct({
  thread: Thread,
  titleMatch: Schema.Boolean,
  /** How many of its messages matched, of which `matches` holds the newest few. */
  matchCount: Schema.Number,
  matches: Schema.Array(MessageMatch),
});
export type SearchHit = typeof SearchHit.Type;

const WORD = /[\p{L}\p{N}]+/gu;
const MAX_TERMS = 8;

/** Lower case with accents removed, so "Café" and "cafe" compare equal. */
export const foldWord = (word: string): string => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The words of a search, folded and without repeats. Every word must appear in a match, each as a
 * word or the start of one, so a search can be typed a letter at a time.
 */
export const searchTerms = (query: string): ReadonlyArray<string> => wordsOf(query, foldWord);

/**
 * The same words in lower case with their accents kept, for an index that keeps accents too
 * (PostgreSQL's `simple` configuration), so "Café" still finds "Café" there.
 */
export const searchWords = (query: string): ReadonlyArray<string> => wordsOf(query, (word) => word.toLowerCase());

// Composed first, so an accent typed as a separate mark stays part of its word.
const wordsOf = (query: string, normalize: (word: string) => string): ReadonlyArray<string> =>
  [...new Set((query.normalize("NFC").match(WORD) ?? []).map(normalize).filter((term) => term.length > 0))].slice(
    0,
    MAX_TERMS,
  );

/**
 * The words around the first match in `content`, at most about `width` characters, with matching
 * words marked. Whitespace collapses to single spaces.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: predates the complexity limit (STD-ARCH-012). Split it before adding more branches.
export const snippetOf = (content: string, terms: ReadonlyArray<string>, width = 120): Array<SnippetPart> => {
  const text = content.replace(/\s+/g, " ").trim();
  const ranges: Array<[number, number]> = [];
  for (const word of text.matchAll(WORD)) {
    const folded = foldWord(word[0]);
    if (terms.some((term) => folded.startsWith(term))) ranges.push([word.index, word.index + word[0].length]);
  }
  const first = ranges[0]?.[0] ?? 0;
  // A little context before the first match, then the rest of the width after it.
  let start = Math.max(0, first - Math.floor(width / 3));
  let end = Math.min(text.length, start + width);
  start = Math.max(0, end - width);
  // Cut at spaces so no word is split.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    start = space === -1 || space >= first ? start : space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    end = space > (ranges[0]?.[1] ?? 0) ? space : end;
  }

  const parts: Array<SnippetPart> = [];
  const push = (part: string, match: boolean) => {
    if (part.length > 0) parts.push({ text: part, match });
  };
  let at = start;
  for (const [from, to] of ranges) {
    if (to <= start || from >= end) continue;
    push(text.slice(at, Math.max(at, from)), false);
    push(text.slice(Math.max(at, from), Math.min(to, end)), true);
    at = Math.min(to, end);
  }
  push(text.slice(at, end), false);
  if (start > 0) parts.unshift({ text: "…", match: false });
  if (end < text.length) parts.push({ text: "…", match: false });
  return parts;
};
