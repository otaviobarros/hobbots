import type { MessageId, ReplyStep } from "@hobbots/domain";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";

/** Whether this client hears the hub's live events right now. */
export type ConnectionState = "connecting" | "live" | "reconnecting";

const connectionKey = ["connection"] as const;

export const connectionQuery = queryOptions({
  queryKey: connectionKey,
  queryFn: (): ConnectionState => "connecting",
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
});

export const setConnection = (queryClient: QueryClient, state: ConnectionState) =>
  queryClient.setQueryData<ConnectionState>(connectionKey, state);

export const useConnection = (): ConnectionState => useQuery(connectionQuery).data ?? "connecting";

/**
 * The steps of a running reply, as the runtime reports them. They are live only: the hub sends
 * them while the reply runs and again on connect, and keeps none once it ends.
 */
const stepsKey = (messageId: MessageId) => ["steps", messageId] as const;

const stepsQuery = (messageId: MessageId) =>
  queryOptions({
    queryKey: stepsKey(messageId),
    queryFn: (): ReadonlyArray<ReplyStep> => [],
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });

/** Each update carries the whole list, so it replaces the one held. */
export const setSteps = (queryClient: QueryClient, messageId: MessageId, steps: ReadonlyArray<ReplyStep>) =>
  queryClient.setQueryData<ReadonlyArray<ReplyStep>>(stepsKey(messageId), steps);

export const useReplySteps = (messageId: MessageId): ReadonlyArray<ReplyStep> =>
  useQuery(stepsQuery(messageId)).data ?? [];
