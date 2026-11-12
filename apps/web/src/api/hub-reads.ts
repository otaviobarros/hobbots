import { type Query, type QueryClient, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { statusKey } from "./hub-status.ts";
import { summariesRoot } from "./quest-summaries.ts";
import { readFailed } from "./snapshot-reads.ts";

/**
 * The reads of what the hub publishes (ADR 037): its status and its Quest summaries. Every page
 * renders them, so until they are read a hob rests unless its record says paused and a Quest shows no
 * progress; when one fails, the window says so once with a way to read it again (STD-REACT-015,
 * STD-UI-009), so an empty view is never taken for a quiet hub.
 */
const isHubRead = (query: Query) => query.queryKey[0] === statusKey[0] || query.queryKey[0] === summariesRoot;
// Not the query's status: an event that patched it since would have cleared that (see snapshot-reads.ts).
const hasFailed = (query: Query) => isHubRead(query) && readFailed(query);

/** Whether any read of what the hub publishes failed and has not been read since. */
export const hubReadFailed = (client: QueryClient): boolean =>
  client.getQueryCache().findAll({ predicate: hasFailed }).length > 0;

/** Reads again every read of what the hub publishes that failed. */
export const retryHubReads = (client: QueryClient): Promise<void> => client.refetchQueries({ predicate: hasFailed });

/** The hub's reads as the window shows them: all well, or failed with a way to read them again. */
export type HubReads =
  | { readonly kind: "read" }
  | { readonly kind: "failed"; readonly retrying: boolean; readonly retry: () => void };

const READ: HubReads = { kind: "read" };

export const useHubReads = (): HubReads => {
  const client = useQueryClient();
  const failed = useSyncExternalStore(
    (changed) => client.getQueryCache().subscribe(changed),
    () => hubReadFailed(client),
  );
  const retrying = useIsFetching({ predicate: hasFailed }) > 0;
  if (!failed) return READ;
  return { kind: "failed", retrying, retry: () => void retryHubReads(client) };
};
