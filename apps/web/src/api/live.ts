import type { AgentId, MessageId, ReplyStep, ThreadId } from "@hobbots/domain";
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

/** A message sent while the hub was out of reach, held until the hub takes it. */
export type WaitingMessage = { readonly id: string; readonly content: string };

/** Where waiting messages are held: a thread, or a hob's fresh page before its thread exists. */
export type WaitingPlace = ThreadId | `new-${AgentId}`;

const waitingKey = (place: WaitingPlace) => ["waiting", place] as const;

const waitingQuery = (place: WaitingPlace) =>
  queryOptions({
    queryKey: waitingKey(place),
    queryFn: (): ReadonlyArray<WaitingMessage> => [],
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

export const updateWaiting = (
  queryClient: QueryClient,
  place: WaitingPlace,
  update: (old: ReadonlyArray<WaitingMessage>) => ReadonlyArray<WaitingMessage>,
) => queryClient.setQueryData<ReadonlyArray<WaitingMessage>>(waitingKey(place), (old = []) => update(old));

/** The messages waiting in a place, oldest first: they go out in that order. */
export const useWaiting = (place: WaitingPlace): ReadonlyArray<WaitingMessage> =>
  useQuery(waitingQuery(place)).data ?? [];
