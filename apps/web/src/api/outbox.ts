import type { AgentId, ThreadId } from "@hobbots/domain";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { type ConnectionState, connectionQuery } from "./live.ts";
import { sendPrompt, startThread } from "./queries.ts";

/**
 * Messages sent while the hub was out of reach. They wait in order and go out one at a time once it
 * is back, and each leaves only when the hub has taken it. They live outside the Query cache, so a
 * resync cannot replace them, and outside any component, so a delivery is acknowledged even after
 * its chat has closed.
 */
export type WaitingMessage = { readonly id: string; readonly content: string };

/** Where messages wait: a thread, or a hob's fresh page before its thread exists. */
export type WaitingPlace = ThreadId | `new-${AgentId}`;

export interface Outbox {
  /** Oldest first, the order they go out in. */
  readonly messages: ReadonlyArray<WaitingMessage>;
  /** The message being handed to the hub now. It can no longer be taken back. */
  readonly sending: string | undefined;
  /** The hub refused the first message. It stays until Try again or the next reconnect. */
  readonly refused: boolean;
  /** The thread a fresh page's first message started, which the rest followed into. */
  readonly startedThread: ThreadId | undefined;
}

const EMPTY: Outbox = { messages: [], sending: undefined, refused: false, startedThread: undefined };

const boxes = new Map<WaitingPlace, Outbox>();
const listeners = new Set<() => void>();
let client: QueryClient | undefined;

const box = (place: WaitingPlace): Outbox => boxes.get(place) ?? EMPTY;

const change = (place: WaitingPlace, update: (old: Outbox) => Outbox) => {
  boxes.set(place, update(box(place)));
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useOutbox = (place: WaitingPlace): Outbox => useSyncExternalStore(subscribe, () => box(place));

const live = () => client?.getQueryData<ConnectionState>(connectionQuery.queryKey) === "live";

/** Sends the next waiting message of a place, unless one is already on its way. */
const flush = (place: WaitingPlace) => {
  const { messages, sending, refused } = box(place);
  const first = messages[0];
  if (client === undefined || first === undefined || sending !== undefined || refused || !live()) return;
  change(place, (old) => ({ ...old, sending: first.id }));
  const delivered = place.startsWith("new-")
    ? startThread(client, place.slice("new-".length) as AgentId, first.content).then(({ thread }) => thread.id)
    : sendPrompt(client, place as ThreadId, first.content).then(() => place as ThreadId);
  delivered.then(
    (threadId) => {
      // Read now, not when the send began: messages taken back meanwhile stay out.
      const rest = box(place).messages.filter((message) => message.id !== first.id);
      if (threadId === place) {
        change(place, (old) => ({ ...old, sending: undefined, messages: rest }));
        flush(place);
        return;
      }
      change(place, (old) => ({ ...old, sending: undefined, messages: [], startedThread: threadId }));
      change(threadId, (old) => ({ ...old, messages: [...old.messages, ...rest] }));
      flush(threadId);
    },
    () => change(place, (old) => ({ ...old, sending: undefined, refused: true })),
  );
};

/** Lets the outbox send through this client. */
export const attachOutbox = (queryClient: QueryClient) => {
  client = queryClient;
};

/** Back online, every place sends what waits; going offline gives refused messages another try. */
export const connectionChanged = (state: ConnectionState) => {
  for (const place of [...boxes.keys()]) {
    if (state === "live") flush(place);
    else if (box(place).refused) change(place, (old) => ({ ...old, refused: false }));
  }
};

/** Adds a message behind those already waiting, and sends it if the hub is there. */
export const enqueue = (place: WaitingPlace, content: string) => {
  change(place, (old) => ({ ...old, messages: [...old.messages, { id: crypto.randomUUID(), content }] }));
  flush(place);
};

/** Takes a waiting message back to edit. The one on its way cannot be, so this returns nothing. */
export const takeBack = (place: WaitingPlace, id: string): string | undefined => {
  const { messages, sending } = box(place);
  const message = messages.find((m) => m.id === id);
  if (message === undefined || sending === id) return undefined;
  change(place, (old) => ({
    ...old,
    messages: old.messages.filter((m) => m.id !== id),
    // The refusal belonged to that message; the next one gets its own try.
    refused: old.refused && old.messages[0]?.id !== id,
  }));
  flush(place);
  return message.content;
};

export const tryAgain = (place: WaitingPlace) => {
  change(place, (old) => ({ ...old, refused: false }));
  flush(place);
};

/** A fresh page has moved to the thread its first message started. */
export const followed = (place: WaitingPlace) => change(place, (old) => ({ ...old, startedThread: undefined }));

/** Drafts carried from a fresh page into the thread it started, so an edit in progress survives. */
const carried = new Map<WaitingPlace, string>();

export const carryDraft = (place: WaitingPlace, draft: string) => {
  if (draft !== "") carried.set(place, draft);
};

export const carriedDraft = (place: WaitingPlace): string => carried.get(place) ?? "";

export const dropCarriedDraft = (place: WaitingPlace) => carried.delete(place);
