import type { ThreadId } from "@hobbots/domain";

// Catch-up in the chat (ADR 037) as one reducer over a union of its steps (STD-REACT-029). Each time
// you come back to a chat that is unread, opening it or bringing its window to the front, is a
// visit: the hub's catch-up is read for it before the chat marks itself read, then shown until you
// fold it. Watching a chat while replies land is no visit, so it shows nothing.

/** The chat in front, and whether you are looking at it, as last seen. */
interface Seen {
  readonly threadId: ThreadId | undefined;
  readonly shown: boolean;
  /** How many visits there were, so each reads its own catch-up. */
  readonly visits: number;
}

export type CatchUpFlow =
  | (Seen & { readonly step: "idle" })
  /** The latest visit's catch-up shows, or is being read. */
  | (Seen & { readonly step: "open" })
  /** You folded the latest visit's catch-up. */
  | (Seen & { readonly step: "folded" });

export type CatchUpEvent =
  /** The chat in front, as each render sees it, and whether it is unread. */
  | { readonly _tag: "See"; readonly threadId: ThreadId | undefined; readonly shown: boolean; readonly unread: boolean }
  | { readonly _tag: "Fold" };

export const CATCH_UP_START: CatchUpFlow = { step: "idle", threadId: undefined, shown: false, visits: 0 };

/**
 * What a render sees: the chat in front, whether you look at it, and whether it is unread for you.
 * Until your unread threads are known (`unread` undefined) the chat counts as not there yet, so the
 * visit waits for them instead of passing as read (ADR 039).
 */
export const seeing = (
  threadId: ThreadId | undefined,
  shown: boolean,
  unread: ReadonlySet<ThreadId> | undefined,
): Extract<CatchUpEvent, { readonly _tag: "See" }> => ({
  _tag: "See",
  threadId: unread === undefined ? undefined : threadId,
  shown,
  unread: threadId !== undefined && unread?.has(threadId) === true,
});

/** Whether `event` changes where you are or whether you look at it. */
export const moves = (flow: CatchUpFlow, event: Extract<CatchUpEvent, { readonly _tag: "See" }>): boolean =>
  flow.threadId !== event.threadId || flow.shown !== event.shown;

export const catchUpStep = (flow: CatchUpFlow, event: CatchUpEvent): CatchUpFlow => {
  switch (event._tag) {
    case "See": {
      if (!moves(flow, event)) return flow;
      const seen = { threadId: event.threadId, shown: event.shown, visits: flow.visits };
      // Arriving at an unread chat in view starts a visit.
      if (event.shown && event.unread && event.threadId !== undefined) {
        return { ...seen, step: "open", visits: flow.visits + 1 };
      }
      // Looking away and back at the same chat keeps what showed; another chat starts with nothing.
      return { ...seen, step: flow.threadId === event.threadId ? flow.step : "idle" };
    }
    case "Fold":
      return flow.step === "open" ? { ...flow, step: "folded" } : flow;
  }
};
