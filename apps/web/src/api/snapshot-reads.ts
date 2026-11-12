import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Whether a read of what the hub publishes failed since it last answered. Live events patch these
 * queries with `setQueryData`, which marks a query successful and drops its error, so a failed read
 * would pass for a complete one as soon as an unrelated event came. Each query instead notes how many
 * failures it had when a read last answered: one that failed after that is failed until a read
 * answers again, whatever events patched it meanwhile.
 */
const failuresAtRead = new WeakMap<Query, number>();

/** A read of `queryKey` answered: what it failed before no longer counts. */
export const noteRead = (client: QueryClient, queryKey: QueryKey) => {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (query !== undefined) failuresAtRead.set(query, query.state.errorUpdateCount);
};

/** Whether the query's read failed since a read last answered. */
export const readFailed = (query: Query): boolean => query.state.errorUpdateCount > (failuresAtRead.get(query) ?? 0);
