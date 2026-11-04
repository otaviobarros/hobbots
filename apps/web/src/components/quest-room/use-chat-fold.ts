import { Schema } from "effect";
import { useState, useSyncExternalStore } from "react";
import { readStored, writeStored } from "../../lib/storage.ts";

/**
 * How wide the window is for the room (ADR 027): from 1280 px the chat column is about 360 px, from
 * 1024 px it narrows to 300 px, and below that it starts folded and opens over the lanes.
 */
export type RoomWidth = "wide" | "medium" | "narrow";

const MEDIUM = "(min-width: 1024px)";
const WIDE = "(min-width: 1280px)";

const subscribe = (changed: () => void) => {
  const queries = [MEDIUM, WIDE].map((query) => globalThis.matchMedia?.(query));
  for (const query of queries) query?.addEventListener("change", changed);
  return () => {
    for (const query of queries) query?.removeEventListener("change", changed);
  };
};

const widthNow = (): RoomWidth =>
  globalThis.matchMedia?.(WIDE).matches ? "wide" : globalThis.matchMedia?.(MEDIUM).matches ? "medium" : "narrow";

export const useRoomWidth = (): RoomWidth => useSyncExternalStore(subscribe, widthNow, () => "wide");

const FOLD_KEY = "room.chat";

/** The fold this device remembers, versioned so a later shape can tell it apart (STD-REACT-026). */
const StoredFold = Schema.Struct({ v: Schema.Literal(1), folded: Schema.Boolean });

export const parseFold = (stored: unknown): boolean => (Schema.is(StoredFold)(stored) ? stored.folded : false);

/**
 * Whether the room's chat column is folded to its rail. Where the window has room for it, the device
 * remembers the choice. In a narrow window the column starts folded every time and opens over the
 * lanes, and that choice is not kept.
 */
export const useChatFold = (width: RoomWidth) => {
  const [kept, setKept] = useState(() => parseFold(readStored<unknown>(FOLD_KEY, null)));
  const [narrowOpen, setNarrowOpen] = useState(false);
  const narrow = width === "narrow";
  const folded = narrow ? !narrowOpen : kept;
  const setFolded = (next: boolean) => {
    if (narrow) {
      setNarrowOpen(!next);
      return;
    }
    writeStored(FOLD_KEY, { v: 1, folded: next });
    setKept(next);
  };
  return { folded, narrow, setFolded };
};

/** How many of a thread's replies the chat held while it was last in view. */
export interface SeenReplies {
  readonly thread: string | undefined;
  readonly count: number;
}

/**
 * The replies the chat has seen, after a read of `replies` in `thread`: a new thread starts from its
 * own count, and while the chat is in view it keeps up; folded, it stays where it was, so a reply
 * after the fold counts as new. Returns `seen` itself when nothing changed.
 */
export const nextSeen = (
  seen: SeenReplies | undefined,
  thread: string | undefined,
  replies: number | undefined,
  hidden: boolean,
): SeenReplies | undefined => {
  if (replies === undefined) return seen;
  if (seen === undefined || seen.thread !== thread || (!hidden && seen.count !== replies))
    return { thread, count: replies };
  return seen;
};

/** Whether `thread` has a reply the chat has not shown since it was folded. */
export const hasUnread = (seen: SeenReplies | undefined, thread: string | undefined, replies: number | undefined) =>
  replies !== undefined && seen !== undefined && seen.thread === thread && replies > seen.count;
