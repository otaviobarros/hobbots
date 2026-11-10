import type { PromptRequest, RuntimeEvent, WebSearchResult } from "@hobbots/agents";
import { Effect } from "effect";

/**
 * Each runtime's report of a web search in Hobbots' terms (ADR 036): the query and the hits the
 * runtime put in its own structured record. Nothing is read from the model's text, so a link the
 * model wrote never counts as a result.
 */

type Searched = Extract<RuntimeEvent, { readonly _tag: "WebSearched" }>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** A hit with a title and a URL, and its snippet where the runtime gave one; anything else is left out. */
const resultOf = (value: unknown): ReadonlyArray<WebSearchResult> => {
  const hit = record(value);
  const url = nonEmpty(hit?.url);
  if (hit === undefined || url === undefined) return [];
  const snippet = nonEmpty(hit.snippet);
  return [{ title: nonEmpty(hit.title) ?? url, url, ...(snippet === undefined ? {} : { snippet }) }];
};

/** The hits, or null when the runtime reported none it structured. */
const hitsOf = (values: ReadonlyArray<unknown>): ReadonlyArray<WebSearchResult> | null => {
  const hits = values.flatMap(resultOf);
  return hits.length === 0 ? null : hits;
};

/**
 * Claude Code's `WebSearch` once it ran: its structured result holds the query and, for each
 * search it made, a `content` list of hits with `title` and `url`; text commentary sits beside
 * them as plain strings, which are left out.
 */
export const claudeWebSearched = (id: string, input: unknown, response: unknown): Searched => {
  const output = record(response);
  const results = Array.isArray(output?.results) ? (output.results as ReadonlyArray<unknown>) : [];
  const content = results.flatMap((entry) => {
    const block = record(entry);
    return Array.isArray(block?.content) ? (block.content as ReadonlyArray<unknown>) : [];
  });
  return {
    _tag: "WebSearched",
    id,
    query: nonEmpty(output?.query) ?? nonEmpty(record(input)?.query) ?? "",
    results: hitsOf(content),
  };
};

/** Codex's `webSearch` item's action, as its App Server reports it (0.166.0 and later). */
export type CodexWebSearchAction =
  | { readonly type: "search"; readonly query?: string | null; readonly queries?: ReadonlyArray<string> | null }
  | { readonly type: "openPage" | "findInPage"; readonly url?: string | null }
  | { readonly type: "other" };

/**
 * A completed Codex `webSearch` item that searched: its query from the action, which holds the
 * whole search in `query` or `queries` (`item.query` can be a shortened display string), and the
 * hits in `results`, which Codex passes on as opaque JSON. An action that opened or searched a page
 * is not a search, so it reports nothing (`codexPageRead` reads it).
 */
export const codexWebSearched = (item: {
  readonly id: string;
  readonly query?: string | null;
  readonly action?: CodexWebSearchAction | null;
  readonly results?: ReadonlyArray<unknown> | null;
}): Searched | undefined => {
  const action = item.action;
  if (action?.type !== "search") return undefined;
  const queries = [action.query, ...(action.queries ?? [])].flatMap((query) => nonEmpty(query) ?? []);
  return {
    _tag: "WebSearched",
    id: item.id,
    query: [...new Set(queries)].join("; ") || (nonEmpty(item.query) ?? ""),
    results: hitsOf(item.results ?? []),
  };
};

/** What a session read where Codex's search names no page: its source on the read-the-web mark. */
export const CODEX_SEARCH_PAGE = "a page Codex's web search opened";

/**
 * The page a completed Codex `webSearch` item read, when its action was not a search: `openPage`
 * and `findInPage` name a URL the model chose, and any other action may read one too. Its text
 * reached the model, so the session is marked as having read the web (ADR 036), but the URL is
 * never found, since the model wrote it.
 */
export const codexPageRead = (item: { readonly action?: CodexWebSearchAction | null }): string | undefined => {
  const action = item.action;
  if (action == null || action.type === "search") return undefined;
  return (action.type === "other" ? undefined : nonEmpty(action.url)) ?? CODEX_SEARCH_PAGE;
};

/**
 * Waits for the turn's `recordSearch` (ADR 036), which makes a search's results found before the
 * model can act on them. A defect is ignored, so a search is never lost to a failed record.
 */
export const recordSearched = (record: PromptRequest["recordSearch"], searched: Searched): Effect.Effect<void> =>
  record ? record(searched).pipe(Effect.catchDefect(() => Effect.void)) : Effect.void;
