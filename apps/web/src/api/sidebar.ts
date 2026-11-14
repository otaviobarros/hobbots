import type { HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";

const sidebarKey = ["sidebar"] as const;

/**
 * Your camps and direct messages as the hub sorts them by members (ADR 039, The sidebar). The hub
 * works out which section each thread is in on every read; the client only shows it (STD-REACT-028).
 */
export const sidebarQuery = queryOptions({
  queryKey: sidebarKey,
  ...followsEvents,
  queryFn: () => call((c) => c.sidebar.current()),
});

/**
 * A thread was made, archived or restored, a hob came or went, a member joined or left, or what you
 * read changed: the sidebar is read again. A read already in flight may predate the change, so it is
 * cancelled first (STD-REACT-012).
 */
export const sidebarChanged = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: sidebarKey, exact: true });
  await queryClient.invalidateQueries({ queryKey: sidebarKey, exact: true });
};

/** The events that move a thread between the sidebar's sections, or into or out of it. */
const SIDEBAR_EVENTS: ReadonlySet<HobbotsEvent["_tag"]> = new Set([
  "AgentUpserted",
  "ThreadUpserted",
  "CampMade",
  "ChatStartedFresh",
  "ChapterMoved",
  "ThreadMemberAdded",
  "ThreadMemberChanged",
]);

/** Reads the sidebar again after an event that changes what it lists; the event's own handling goes on. */
export const applySidebarEvent = (queryClient: QueryClient, event: HobbotsEvent) => {
  if (SIDEBAR_EVENTS.has(event._tag)) void sidebarChanged(queryClient);
};
