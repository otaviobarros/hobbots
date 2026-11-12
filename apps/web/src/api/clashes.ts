import type { HobbotsEvent, ThreadId } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";

// The open clashes on paths and branches a chat or camp shows as Heads-ups (ADR 037, #1390), from
// the hub's claims register.

const clashesKey = (threadId: ThreadId) => ["clashes", threadId] as const;

/** The open clashes that touch the thread's quests, oldest first. */
export const clashesQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: clashesKey(threadId),
    queryFn: () => call((c) => c.claims.clashes({ params: { threadId } })),
    ...followsEvents,
  });

export type ClaimEvent = Extract<
  HobbotsEvent,
  { readonly _tag: "ClaimMade" | "ClaimContested" | "ClaimCleared" | "ClaimReleased" }
>;
const CLAIM_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "ClaimMade",
  "ClaimContested",
  "ClaimCleared",
  "ClaimReleased",
]);
export const isClaimEvent = (event: HobbotsEvent): event is ClaimEvent => CLAIM_EVENTS.has(event._tag);

/**
 * A claim was made, contested, cleared or released. A claim names its Task, not the thread, and a
 * clash can touch two camps, so every thread's clashes are read again (STD-REACT-012).
 */
export const applyClaimEvent = async (queryClient: QueryClient): Promise<void> => {
  // A first read still on its way may have been taken before the change, so it is dropped.
  await queryClient.cancelQueries({ queryKey: ["clashes"] });
  await queryClient.invalidateQueries({ queryKey: ["clashes"] });
};
