import {
  type MemoryChange,
  type MemoryChanged,
  type MemoryPath,
  type MemoryScope,
  type MemoryVersion,
  memoryScopeKey,
} from "@hobbots/domain";
import { keepPreviousData, type QueryClient, queryOptions } from "@tanstack/react-query";
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

const memoryKey = ["memory"] as const;

export const memoryKeys = {
  all: memoryKey,
  overview: [...memoryKey, "overview"] as const,
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

/** Every scope that holds a page, with its count. */
export const memoryOverviewQuery = queryOptions({
  queryKey: memoryKeys.overview,
  queryFn: () => call((c) => c.memory.overview()),
  ...retryWhileDown,
});

/** What memory saved lately, newest first; the stream adds what the hub finds after. */
export const memoryChangesQuery = queryOptions({
  queryKey: memoryKeys.changes,
  queryFn: () => call((c) => c.memory.changes()),
  ...retryWhileDown,
});

export const memoryPagesQuery = (scope: MemoryScope) =>
  queryOptions({
    queryKey: memoryKeys.pages(scope),
    queryFn: () => call((c) => c.memory.pages({ query: { scope: memoryScopeKey(scope) } })),
    ...retryWhileDown,
  });

export const memoryPageQuery = (scope: MemoryScope, path: MemoryPath) =>
  queryOptions({
    queryKey: memoryKeys.page(scope, path),
    queryFn: () => call((c) => c.memory.page({ query: { scope: memoryScopeKey(scope), path } })),
    ...retryWhileDown,
  });

/** A version's text never changes, so it is read once. */
export const memoryVersionQuery = (scope: MemoryScope, path: MemoryPath, version: MemoryVersion) =>
  queryOptions({
    queryKey: memoryKeys.version(scope, path, version),
    queryFn: () => call((c) => c.memory.version({ query: { scope: memoryScopeKey(scope), path, version } })),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const memorySearchQuery = (q: string, scope: MemoryScope | null) =>
  queryOptions({
    queryKey: memoryKeys.search(q, scope),
    queryFn: () =>
      call((c) => c.memory.search({ query: scope === null ? { q } : { q, scope: memoryScopeKey(scope) } })),
    enabled: q.trim() !== "",
    placeholderData: keepPreviousData,
  });

const changeKey = (change: MemoryChange) => `${memoryScopeKey(change.scope)}\n${change.path}\n${change.version}`;

/** `changes` before `known`, newest first, each change once. */
export const withChanges = (known: ReadonlyArray<MemoryChange>, changes: ReadonlyArray<MemoryChange>) => {
  const all = new Map([...changes, ...known].map((change) => [changeKey(change), change]));
  return [...all.values()].sort((a, b) => b.at.localeCompare(a.at));
};

/**
 * What the hub found memory saved: What changed gains it now, and every other memory read is read
 * again, so a count, a scope's list or an open page shows the save (STD-REACT-012).
 */
export const applyMemoryChanged = (queryClient: QueryClient, event: MemoryChanged) => {
  queryClient.setQueryData<ReadonlyArray<MemoryChange>>(memoryKeys.changes, (old) =>
    old === undefined ? old : withChanges(old, event.changes),
  );
  void queryClient
    .cancelQueries({ queryKey: memoryKeys.all, predicate: (query) => query.queryKey[1] !== "changes" })
    .then(() =>
      queryClient.invalidateQueries({
        queryKey: memoryKeys.all,
        predicate: (query) => query.queryKey[1] !== "changes",
      }),
    );
};
