import type { ChannelId, HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { refreshTaskClaims } from "./task-claims.ts";

// The open clashes on paths and branches a chat or camp shows as Heads-ups (ADR 037, #1390), from
// the hub's claims register.

const clashesKey = (channelId: ChannelId) => ["clashes", channelId] as const;

/** The open clashes that touch the channel's quests, oldest first. */
export const clashesQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: clashesKey(channelId),
    queryFn: () => call((c) => c.claims.clashes({ params: { channelId } })),
    ...followsEvents,
  });

export type ClaimEvent = Extract<
  HobbotsEvent,
  {
    readonly _tag:
      | "ClaimMade"
      | "ClaimContested"
      | "ClaimCleared"
      | "ClaimTakenOver"
      | "ClaimGivenBack"
      | "ClaimReleased";
  }
>;
const CLAIM_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "ClaimMade",
  "ClaimContested",
  "ClaimCleared",
  "ClaimTakenOver",
  "ClaimGivenBack",
  "ClaimReleased",
]);
export const isClaimEvent = (event: HobbotsEvent): event is ClaimEvent => CLAIM_EVENTS.has(event._tag);

/**
 * A claim was made, contested, cleared, taken over, given back or released. A claim names its Task, not the channel, and a
 * clash can touch two camps, so every channel's clashes are read again (STD-REACT-012), with the
 * claims of the claim's Task (#1449).
 */
export const applyClaimEvent = async (queryClient: QueryClient, event?: ClaimEvent): Promise<void> => {
  // Only the changed claim's Task reads its claims again; a moved camp reads every Task's.
  void refreshTaskClaims(queryClient, event?.claim.taskId);
  // A first read still on its way may have been taken before the change, so it is dropped.
  await queryClient.cancelQueries({ queryKey: ["clashes"] });
  await queryClient.invalidateQueries({ queryKey: ["clashes"] });
};
