import {
  type Agent,
  type AgentId,
  type ApprovalRequest,
  type BackpackItem,
  type Message,
  openBlocker,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";
import { inboxWindow } from "./inbox-window.ts";

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
  | { readonly kind: "approval"; readonly revision: number; readonly value: ApprovalRequest }
  | { readonly kind: "backpack"; readonly revision: number; readonly value: BackpackItem }
  | { readonly kind: "removed"; readonly revision: number };

type Kind = Exclude<OverlayEntry["kind"], "removed">;

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
 * cached query but the local ones is marked stale and fetched again, since what was missed cannot be replayed.
 */
export const startGeneration = (client: QueryClient) => {
  const state = syncState(client);
  state.generation += 1;
  state.overlay.clear();
  void client.invalidateQueries({ predicate: (query) => query.meta?.local !== true });
};

export const recordAgent = (client: QueryClient, agent: Agent) =>
  record(client, `agent:${agent.id}`, { kind: "agent", revision: agent.revision, value: agent });
export const recordThread = (client: QueryClient, thread: Thread) =>
  record(client, `thread:${thread.id}`, { kind: "thread", revision: thread.revision, value: thread });
export const recordMessage = (client: QueryClient, message: Message) =>
  record(client, `message:${message.id}`, { kind: "message", revision: message.revision, value: message });
export const recordApproval = (client: QueryClient, approval: ApprovalRequest) =>
  record(client, `approval:${approval.id}`, { kind: "approval", revision: approval.revision, value: approval });
export const recordBackpackItem = (client: QueryClient, item: BackpackItem) =>
  record(client, `backpack:${item.id}`, { kind: "backpack", revision: item.revision, value: item });
/** A removed message never returns (IDs are not reused), so its tombstone outranks every version. */
export const recordRemovedMessage = (client: QueryClient, messageId: string) =>
  record(client, `message:${messageId}`, { kind: "removed", revision: Number.POSITIVE_INFINITY });

const record = (client: QueryClient, key: string, entry: OverlayEntry) => {
  const overlay = syncState(client).overlay;
  const known = overlay.get(key);
  if (known !== undefined && entry.revision < known.revision) return;
  // Re-inserted so the overlay lists entities in the order they last changed, the order in which
  // reconcile applies them.
  overlay.delete(key);
  overlay.set(key, entry);
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
 * A cached list with the arriving version of an entity in place of an older one, at the end when it
 * is new to the list, or out of the list when the version kept no longer `keeps` it. An older
 * arriving version leaves the list as it is.
 */
export const withNewer = <T extends { readonly id: string; readonly revision: number }>(
  old: ReadonlyArray<T> | undefined,
  item: T,
  keeps: (kept: T) => boolean,
): ReadonlyArray<T> | undefined => {
  if (old === undefined) return old;
  const known = old.find((each) => each.id === item.id);
  const kept = newer(known, item);
  if (kept === known) return old;
  const rest = old.filter((each) => each.id !== item.id);
  return keeps(kept) ? [...rest, kept] : rest;
};

/**
 * A response's rows with the generation's overlay on top, applied as the events were: a newer
 * version replaces its row through `upsert` (so a queued message that started moves to the end, as
 * it does live), a newer tombstone removes it, and an entity that belongs to the query but is
 * missing from the response was created after it was read, so it is added. Everything else missing
 * from the response is gone.
 */
const reconcile = <T extends { readonly id: string; readonly revision: number }>(
  client: QueryClient,
  rows: ReadonlyArray<T>,
  kind: Kind,
  belongs: (value: T) => boolean,
  upsert: (list: ReadonlyArray<T>, item: T) => Array<T>,
  cached: ReadonlyArray<T> | undefined,
): Array<T> => {
  const overlay = syncState(client).overlay;
  const known = new Map((cached ?? []).map((item) => [item.id, item]));
  // Text a delta already delivered stays, even when the version at hand holds an older checkpoint.
  // Only for the same revision: other cached versions may be from an earlier generation.
  const withCachedText = (value: T) => {
    const cachedVersion = known.get(value.id);
    return cachedVersion?.revision === value.revision ? newer(cachedVersion, value) : value;
  };
  let result = rows.map(withCachedText);
  for (const [key, entry] of overlay) {
    if (!key.startsWith(`${kind}:`)) continue;
    const id = key.slice(kind.length + 1);
    const row = result.find((item) => item.id === id);
    if (entry.kind === "removed") {
      if (row !== undefined && entry.revision > row.revision) result = result.filter((item) => item !== row);
      continue;
    }
    const value = withCachedText(entry.value as unknown as T);
    if (row === undefined) result = [...result, value];
    else if (newer(row, value) !== row) result = upsert(result, newer(row, value));
  }
  return result.filter(belongs);
};

const replaceById = <T extends { readonly id: string }>(list: ReadonlyArray<T>, item: T) =>
  list.map((existing) => (existing.id === item.id ? item : existing));

/**
 * Wraps a list query's fetch so its response belongs to the current generation: a response that
 * lands after a new generation began is discarded and fetched again, and every response is
 * reconciled with the overlay.
 */
const synced =
  <T extends { readonly id: string; readonly revision: number }>(
    fetch: () => Promise<ReadonlyArray<T>>,
    kind: Kind,
    belongs: (value: T) => boolean,
    order: (items: Array<T>) => Array<T> = (items) => items,
    upsert: (list: ReadonlyArray<T>, item: T) => Array<T> = replaceById,
  ) =>
  async ({ client, queryKey }: QueryFunctionContext): Promise<ReadonlyArray<T>> => {
    const state = syncState(client);
    for (;;) {
      const generation = state.generation;
      const rows = await fetch();
      if (state.generation !== generation) continue;
      return order(reconcile(client, rows, kind, belongs, upsert, client.getQueryData<ReadonlyArray<T>>(queryKey)));
    }
  };

export const syncedAgents = (
  fetch: () => Promise<ReadonlyArray<Agent>>,
  retired: boolean,
  order?: (items: Array<Agent>) => Array<Agent>,
) => synced(fetch, "agent", (agent) => (agent.status === "retired") === retired, order);

/** A hob's live threads, or with `archived` its archived ones; a thread moves between them by its `archivedAt`. */
export const syncedThreads = (
  agentId: AgentId,
  fetch: () => Promise<ReadonlyArray<Thread>>,
  order: (items: Array<Thread>) => Array<Thread>,
  archived: boolean,
) =>
  synced(fetch, "thread", (thread) => thread.agentId === agentId && (thread.archivedAt !== null) === archived, order);

export const syncedMessages = (
  threadId: ThreadId,
  fetch: () => Promise<ReadonlyArray<Message>>,
  upsert: (list: ReadonlyArray<Message>, message: Message) => Array<Message>,
) => synced(fetch, "message", (message) => message.threadId === threadId, undefined, upsert);

export const syncedApprovals = (threadId: ThreadId, fetch: () => Promise<ReadonlyArray<ApprovalRequest>>) =>
  synced(fetch, "approval", (approval) => approval.threadId === threadId);

/**
 * One request, as the hub has it now, unless an event this generation brought a newer version. A
 * response that lands after a new generation began is fetched again.
 */
export const syncedApproval =
  (approvalId: string, fetch: () => Promise<ApprovalRequest>) =>
  async ({ client }: QueryFunctionContext): Promise<ApprovalRequest> => {
    const state = syncState(client);
    for (;;) {
      const generation = state.generation;
      const fetched = await fetch();
      if (state.generation !== generation) continue;
      const known = state.overlay.get(`approval:${approvalId}`);
      return known?.kind === "approval" ? newer(fetched, known.value) : fetched;
    }
  };

/** The Inbox's requests from every thread, kept to the hub's window and order. */
export const syncedInbox = (fetch: () => Promise<ReadonlyArray<ApprovalRequest>>) =>
  synced(fetch, "approval", () => true, inboxWindow);

/** The items whose blocker waits for the user (IN-007): one leaves once its blocker is decided. */
export const syncedBlockers = (fetch: () => Promise<ReadonlyArray<BackpackItem>>) =>
  synced(fetch, "backpack", (item) => openBlocker(item) !== undefined);

/**
 * Every hob's backpack items that have not failed: the open ones the hub read, and the ones that
 * changed since during this generation, resolved ones too, so a view can say how one was handled.
 * A failed item is a blocker and lives in the blocker list instead.
 */
export const syncedBackpack = (fetch: () => Promise<ReadonlyArray<BackpackItem>>) =>
  synced(fetch, "backpack", (item) => item.state !== "failed");
