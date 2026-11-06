import { foldWord } from "./search.ts";

/**
 * How a memory search reads its query (ADR 028, #1047). A search is a question in plain words, so a
 * page matches when it holds any of the query's words, each as a word or the start of one, and the
 * pages that hold more of them come first. Words such as "how", "does" or "the" carry nothing to
 * look for and are left out, unless they are all the query holds.
 */

/**
 * The words a plain search leaves out: ai-memory's built-in English stopwords, which it leaves out of
 * a plain search too, so the in-memory store and the engine answer the same.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "should",
  "so",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** A word, with the `-` and `_` inside it kept, as ai-memory's index keeps them: `make tide-check`. */
const WORD = /[\p{L}\p{N}]+(?:[-_]+[\p{L}\p{N}]+)*/gu;
const MAX_TERMS = 8;

/** The words of a page or a query, folded as a search compares them. */
export const memoryWordsOf = (text: string): ReadonlyArray<string> =>
  (text.normalize("NFC").match(WORD) ?? []).map(foldWord);

/** The words a memory search looks for, without repeats or stopwords, at most eight. */
export const memorySearchTerms = (query: string): ReadonlyArray<string> => {
  const words = [...new Set(memoryWordsOf(query))];
  const content = words.filter((word) => !STOPWORDS.has(word));
  return (content.length > 0 ? content : words).slice(0, MAX_TERMS);
};

/** How many of `terms` the `words` of a page hold, each as a word or the start of one. */
export const memoryTermsFound = (words: ReadonlyArray<string>, terms: ReadonlyArray<string>): number =>
  terms.filter((term) => words.some((word) => word.startsWith(term))).length;
