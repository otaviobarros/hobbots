import type { Agent, AgentId, Message, Thread, ThreadId } from "@hobbots/domain";
import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";

/**
 * Keeps the Query cache consistent while query responses and events arrive in either order
 * (ADR 013). The cache belongs to one sync generation, which starts at a fresh `Ready` and lasts
 * across resumed reconnects. During a generation the overlay holds the latest version of every
 * entity an event changed, or a tombstone for one it removed, with its revision; a query response
 * replaces its query's rows and then takes the overlay on top.
 */
interface SyncState {
  generation: number;
  /** The last cursor this client received, to resume from when the stream is opened again. */
  cursor: string | undefined;
  readonly overlay: Map<string, OverlayEntry>;
}

type OverlayEntry =
  | { readonly kind: "agent"; readonly revision: number; readonly value: Agent }
  | { readonly kind: "thread"; readonly revision: number; readonly value: Thread }
  | { readonly kind: "message"; readonly revision: number; readonly value: Message }
  | { readonly kind: "removed"; readonly revision: number };

const states = new WeakMap<QueryClient, SyncState>();

export const syncState = (client: QueryClient): SyncState => {
  let state = states.get(client);
  if (state === undefined) {
    state = { generation: 0, cursor: undefined, overlay: new Map() };
    states.set(client, state);
  }
  return state;
};

/**
 * Starts a new sync generation: the overlay and every pending response are dropped, and every
 * cached query is marked stale and fetched again, since what was missed cannot be replayed.
 */
export const startGeneration = (client: QueryClient) => {
  const state = syncState(client);
  state.generation += 1;
  state.overlay.clear();
  void client.invalidateQueries();
};

export const recordAgent = (client: QueryClient, agent: Agent) =>
  record(client, `agent:${agent.id}`, { kind: "agent", revision: agent.revision, value: agent });
export const recordThread = (client: QueryClient, thread: Thread) =>
  record(client, `thread:${thread.id}`, { kind: "thread", revision: thread.revision, value: thread });
export const recordMessage = (client: QueryClient, message: Message) =>
  record(client, `message:${message.id}`, { kind: "message", revision: message.revision, value: message });
/** A removed message never returns (IDs are not reused), so its tombstone outranks every version. */
export const recordRemovedMessage = (client: QueryClient, messageId: string) =>
  record(client, `message:${messageId}`, { kind: "removed", revision: Number.POSITIVE_INFINITY });

const record = (client: QueryClient, key: string, entry: OverlayEntry) => {
  const overlay = syncState(client).overlay;
  const known = overlay.get(key);
  if (known === undefined || entry.revision >= known.revision) overlay.set(key, entry);
};

/**
 * The version of an entity to keep when another arrives: the higher revision wins. Between two
 * versions with the same revision the arriving one wins, except that a message keeps the longer
 * text, since a reply's text only grows while it streams and checkpoints carry no new revision.
 */
export const newer = <T extends { readonly revision: number }>(known: T | undefined, arriving: T): T => {
  if (known === undefined || arriving.revision > known.revision) return arriving;
  if (arriving.revision < known.revision) return known;
  const knownText = (known as { readonly content?: unknown }).content;
  const arrivingText = (arriving as { readonly content?: unknown }).content;
  return typeof knownText === "string" && typeof arrivingText === "string" && knownText.length > arrivingText.length
    ? ({ ...arriving, content: knownText } as T)
    : arriving;
};

/**
 * A response's rows with the generation's overlay on top: a newer version replaces its row, a newer
 * tombstone removes it, and an entity that belongs to the query but is missing from the response
 * was created after it was read, so it is added. Everything else missing from the response is gone.
 */
const reconcile = <T extends { readonly id: string; readonly revision: number }>(
  client: QueryClient,
  rows: ReadonlyArray<T>,
  kind: "agent" | "thread" | "message",
  belongs: (value: T) => boolean,
  cached: ReadonlyArray<T> | undefined,
): Array<T> => {
  const overlay = syncState(client).overlay;
  const known = new Map((cached ?? []).map((item) => [item.id, item]));
  const result: Array<T> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.id);
    const entry = overlay.get(`${kind}:${row.id}`);
    if (entry?.kind === "removed" && entry.revision > row.revision) continue;
    let value = row;
    if (entry !== undefined && entry.kind === kind) value = newer(value, entry.value as unknown as T);
    // Text a delta already delivered stays, even when the response read an older checkpoint. Only
    // for the same revision: other cached versions may be from an earlier generation.
    const cachedVersion = known.get(row.id);
    if (cachedVersion?.revision === value.revision) value = newer(cachedVersion, value);
    if (belongs(value)) result.push(value);
  }
  for (const [key, entry] of overlay) {
    if (entry.kind !== kind || !key.startsWith(`${kind}:`)) continue;
    const value = entry.value as unknown as T;
    if (!seen.has(value.id) && belongs(value)) result.push(value);
  }
  return result;
};

/**
 * Wraps a list query's fetch so its response belongs to the current generation: a response that
 * lands after a new generation began is discarded and fetched again, and every response is
 * reconciled with the overlay.
 */
const synced =
  <T extends { readonly id: string; readonly revision: number }>(
    fetch: () => Promise<ReadonlyArray<T>>,
    kind: "agent" | "thread" | "message",
    belongs: (value: T) => boolean,
    order: (items: Array<T>) => Array<T> = (items) => items,
  ) =>
  async ({ client, queryKey }: QueryFunctionContext): Promise<ReadonlyArray<T>> => {
    const state = syncState(client);
    for (;;) {
      const generation = state.generation;
      const rows = await fetch();
      if (state.generation !== generation) continue;
      return order(reconcile(client, rows, kind, belongs, client.getQueryData<ReadonlyArray<T>>(queryKey)));
    }
  };

export const syncedAgents = (
  fetch: () => Promise<ReadonlyArray<Agent>>,
  retired: boolean,
  order?: (items: Array<Agent>) => Array<Agent>,
) => synced(fetch, "agent", (agent) => (agent.status === "retired") === retired, order);

export const syncedThreads = (
  agentId: AgentId,
  fetch: () => Promise<ReadonlyArray<Thread>>,
  order: (items: Array<Thread>) => Array<Thread>,
) => synced(fetch, "thread", (thread) => thread.agentId === agentId, order);

export const syncedMessages = (threadId: ThreadId, fetch: () => Promise<ReadonlyArray<Message>>) =>
  synced(fetch, "message", (message) => message.threadId === threadId);
