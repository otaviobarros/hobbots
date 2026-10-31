import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";

/**
 * Marks a query that holds what only this client knows. A resync with the hub fetches every other
 * query again, but refetching one of these would only reset it.
 */
const LOCAL = { local: true } as const;

/** Whether this client hears the hub's live events right now. */
export type ConnectionState = "connecting" | "live" | "reconnecting";

const connectionKey = ["connection"] as const;

export const connectionQuery = queryOptions({
  queryKey: connectionKey,
  queryFn: (): ConnectionState => "connecting",
  meta: LOCAL,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
});

export const setConnection = (queryClient: QueryClient, state: ConnectionState) =>
  queryClient.setQueryData<ConnectionState>(connectionKey, state);

export const useConnection = (): ConnectionState => useQuery(connectionQuery).data ?? "connecting";
