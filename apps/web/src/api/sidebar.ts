import type { SidebarRead } from "@hobbots/api";
import type { HobbotsEvent, ChannelId } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { syncState } from "./sync.ts";

const sidebarKey = ["sidebar"] as const;

/**
 * Your camps and direct messages as the hub sorts them by members (ADR 039, The sidebar). The hub
 * works out which section each channel is in, and what waits on you there, on every read; the client
 * only shows it (STD-REACT-028). A read that lands after a new sync generation began is taken again,
 * since the events between its snapshot and the fresh stream are not replayed (ADR 013).
 */
export const sidebarQuery = queryOptions({
  queryKey: sidebarKey,
  ...followsEvents,
  queryFn: async ({ client }) => {
    const state = syncState(client);
    for (;;) {
      const generation = state.generation;
      const read = await call((c) => c.sidebar.current());
      if (state.generation === generation) return read;
    }
  },
});

/** Whether the sidebar counts a mention of you in `channelId` that you have not read. */
export const mentionsYou = (read: SidebarRead | undefined, channelId: ChannelId): boolean =>
  [...(read?.sidebar.camps ?? []), ...(read?.sidebar.directMessages ?? [])].some(
    (place) => place.channelId === channelId && place.mentions > 0,
  );

/**
 * A channel was made, archived or restored, a hob came or went, a member joined or left, or what you
 * read changed: the sidebar is read again. A read already in flight may predate the change, so it is
 * cancelled first (STD-REACT-012).
 */
export const sidebarChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: sidebarKey, exact: true });
  await queryClient.invalidateQueries({ queryKey: sidebarKey, exact: true });
};

/**
 * The events that move a channel between the sidebar's sections, or into or out of it, and those that
 * change what waits on you in it: a request, a blocker, a question or a Task's state.
 */
const SIDEBAR_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "AgentUpserted",
  "ChannelUpserted",
  "CampMade",
  "ChatStartedFresh",
  "ChapterMoved",
  "ChannelMemberAdded",
  "ChannelMemberChanged",
  "ApprovalRequested",
  "ApprovalResolved",
  "ApprovalMoved",
  "BackpackItemRecorded",
  "BackpackItemChanged",
  "QuestionAsked",
  "QuestionAnswered",
  "QuestionEscalated",
  "QuestionWithdrawn",
  "TaskStateChanged",
]);

/**
 * Whether an event changes what the sidebar lists: one of `SIDEBAR_EVENTS`, a person's message, which
 * may mention you with no turn after it, a queued message taken back, whose mention goes with it, or
 * a pass, whose reply goes.
 * A hob's reply streams many updates, so its unread mark follows `unreadChanged` instead.
 */
const changesSidebar = (event: HobbotsEvent) =>
  SIDEBAR_EVENTS.has(event._tag) ||
  (event._tag === "MessageUpserted" && event.message.role === "user") ||
  (event._tag === "MessageDequeued" && event.reason === "removed") ||
  // A hob that passed leaves no reply, so the camp's last line is what came before it.
  event._tag === "TurnPassed";

/** Reads the sidebar again after an event that changes what it lists; the event's own handling goes on. */
export const applySidebarEvent = (queryClient: QueryClient, event: HobbotsEvent) => {
  if (changesSidebar(event)) void sidebarChanged(queryClient);
};
