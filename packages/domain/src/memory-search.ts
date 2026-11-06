import { foldWord, type SnippetPart, searchTerms, snippetOf } from "./search.ts";

/**
 * How a memory search reads its query (ADR 028, #1047), the same in any language. A page matches when
 * it holds any of the query's words, and the pages that hold more of them come first, so a question in
 * plain words finds the page that answers it. A word of three letters or more matches as a word or the
 * start of one, so "test" finds "testes"; a shorter one, such as "a", "de" or "os", matches only as a
 * whole word, so it never matches most of memory. The best matches come first: ai-memory ranks by
 * bm25, where a word common to every page weighs little, with no list of words to leave out.
 */

/** A word, with the `-` and `_` inside it kept, as ai-memory's index keeps them: `make tide-check`. */
const WORD = /[\p{L}\p{N}]+(?:[-_]+[\p{L}\p{N}]+)*/gu;
const MAX_TERMS = 8;
/** The fewest letters a word needs to match as the start of a longer one. */
const PREFIX_MIN = 3;

/** A word a search looks for, and whether it also matches the start of a longer word. */
export interface MemorySearchTerm {
  readonly word: string;
  readonly prefix: boolean;
}

/** The words of a page or a query, folded as a search compares them. */
export const memoryWordsOf = (text: string): ReadonlyArray<string> =>
  (text.normalize("NFC").match(WORD) ?? []).map(foldWord);

const isPrefix = (word: string) => [...word].length >= PREFIX_MIN;

/** The words a memory search looks for, without repeats, at most eight. */
export const memorySearchTerms = (query: string): ReadonlyArray<MemorySearchTerm> =>
  [...new Set(memoryWordsOf(query))].slice(0, MAX_TERMS).map((word) => ({ word, prefix: isPrefix(word) }));

/** How many of `terms` the `words` of a page hold. */
export const memoryTermsFound = (words: ReadonlyArray<string>, terms: ReadonlyArray<MemorySearchTerm>): number =>
  terms.filter((term) => words.some((word) => (term.prefix ? word.startsWith(term.word) : word === term.word))).length;

/**
 * A memory hit's snippet with the words the search matched marked, as the search matched them. A
 * snippet marks plain words, so `tide-check` is marked as `tide` and `check`, each by the same rule.
 */
export const memorySnippetOf = (
  content: string,
  terms: ReadonlyArray<MemorySearchTerm>,
  width?: number,
): Array<SnippetPart> =>
  snippetOf(content, searchTerms(terms.map((term) => term.word).join(" ")), width, (word, piece) =>
    isPrefix(piece) ? word.startsWith(piece) : word === piece,
  );
