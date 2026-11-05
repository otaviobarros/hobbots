import {
  type MemoryChange,
  type MemoryChanged,
  type MemoryPath,
  type MemoryScope,
  type MemoryVersion,
  memoryScopeKey,
} from "@hobbots/domain";
import { keepPreviousData, type Query, type QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";

/**
 * Memory, as the Memory page reads it through the hub (ADR 028). A read that finds memory not
 * answering keeps what it last loaded and tries again every 30 seconds.
 */

/** How often a read tries again while memory does not answer. */
const MEMORY_RETRY_MS = 30_000;

/** Whether `error` says memory did not answer, rather than that the hub could not be reached. */
export const memoryNotAnswering = (error: unknown): boolean =>
  error instanceof ApiError && error.tag === "MemoryNotAnswering";

/** Whether `error` says there is no such page. */
export const memoryPageGone = (error: unknown): boolean =>
  error instanceof ApiError && error.tag === "MemoryPageNotFound";

const memoryKey = ["memory-pages"] as const;

export const memoryKeys = {
  all: memoryKey,
  scopes: [...memoryKey, "scopes"] as const,
  changes: [...memoryKey, "changes"] as const,
  pages: (scope: MemoryScope) => [...memoryKey, "pages", memoryScopeKey(scope)] as const,
  page: (scope: MemoryScope, path: MemoryPath) => [...memoryKey, "page", memoryScopeKey(scope), path] as const,
  version: (scope: MemoryScope, path: MemoryPath, version: MemoryVersion) =>
    [...memoryKey, "version", memoryScopeKey(scope), path, version] as const,
  search: (q: string, scope: MemoryScope | null) =>
    [...memoryKey, "search", q, scope === null ? "all" : memoryScopeKey(scope)] as const,
};

/** Tries again every 30 seconds while the last read failed, and not at all while it holds. */
const retryWhileDown = {
  refetchInterval: (query: { state: { status: string } }) => (query.state.status === "error" ? MEMORY_RETRY_MS : false),
};

/**
 * Every scope that holds a page, with its count. Read every 30 seconds while the page shows it,
 * failed or not: memory stopping after the pages loaded says so within one read, over what loaded.
 */
export const memoryScopesQuery = queryOptions({
  queryKey: memoryKeys.scopes,
  queryFn: () => call((c) => c.memoryPages.scopes()),
  refetchInterval: MEMORY_RETRY_MS,
});

/** What memory saved lately, newest first; the stream adds what the hub finds after. */
export const memoryChangesQuery = queryOptions({
  queryKey: memoryKeys.changes,
  queryFn: () => call((c) => c.memoryPages.changes()),
  ...retryWhileDown,
});

export const memoryPagesQuery = (scope: MemoryScope) =>
  queryOptions({
    queryKey: memoryKeys.pages(scope),
    queryFn: () => call((c) => c.memoryPages.pages({ query: { scope: memoryScopeKey(scope) } })),
    ...retryWhileDown,
  });

export const memoryPageQuery = (scope: MemoryScope, path: MemoryPath) =>
  queryOptions({
    queryKey: memoryKeys.page(scope, path),
    queryFn: () => call((c) => c.memoryPages.page({ query: { scope: memoryScopeKey(scope), path } })),
    ...retryWhileDown,
  });

/** A version's text never changes, so it is read once. */
export const memoryVersionQuery = (scope: MemoryScope, path: MemoryPath, version: MemoryVersion) =>
  queryOptions({
    queryKey: memoryKeys.version(scope, path, version),
    queryFn: () => call((c) => c.memoryPages.version({ query: { scope: memoryScopeKey(scope), path, version } })),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const memorySearchQuery = (q: string, scope: MemoryScope | null) =>
  queryOptions({
    queryKey: memoryKeys.search(q, scope),
    queryFn: () =>
      call((c) => c.memoryPages.search({ query: scope === null ? { q } : { q, scope: memoryScopeKey(scope) } })),
    enabled: q.trim() !== "",
    placeholderData: keepPreviousData,
  });

const changeKey = (change: MemoryChange) => `${memoryScopeKey(change.scope)}\n${change.path}\n${change.version}`;

/** `changes` before `known`, newest first, each change once. */
export const withChanges = (known: ReadonlyArray<MemoryChange>, changes: ReadonlyArray<MemoryChange>) => {
  const all = new Map([...changes, ...known].map((change) => [changeKey(change), change]));
  return [...all.values()].sort((a, b) => b.at.localeCompare(a.at));
};

/** Every memory read but a version's changes, which a later save never alters. */
const live = { queryKey: memoryKeys.all, predicate: (query: Query) => query.queryKey[1] !== "version" };

/**
 * What the hub found memory saved: a read still in flight is cancelled, since it may answer from
 * before the save; What changed gains the save now; and every memory read is read again, so a count,
 * a scope's list or an open page shows it (STD-REACT-012). The hub keeps what it found, so a read
 * made after the event always holds it.
 */
export const applyMemoryChanged = async (queryClient: QueryClient, event: MemoryChanged) => {
  await queryClient.cancelQueries(live);
  queryClient.setQueryData<ReadonlyArray<MemoryChange>>(memoryKeys.changes, (old) =>
    old === undefined ? old : withChanges(old, event.changes),
  );
  await queryClient.invalidateQueries(live);
};

/**
 * Reads memory again when the event stream is ready, a resumed one included: a save the hub found
 * while this client was away is never streamed again.
 */
export const refreshMemory = (queryClient: QueryClient) => queryClient.invalidateQueries(live);
