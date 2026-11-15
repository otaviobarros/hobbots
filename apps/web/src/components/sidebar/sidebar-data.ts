import type { SidebarRead } from "@hobbots/api";
import type { Agent, Channel, ChannelId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { agentsQuery, channelsQuery } from "../../api/queries.ts";
import { sidebarQuery } from "../../api/sidebar.ts";

/** What the sidebar shows: the hub's sections, the hobs, and every hob's live channels by id. */
export interface SidebarData {
  readonly read: SidebarRead | undefined;
  readonly hobs: ReadonlyArray<Agent>;
  readonly channels: ReadonlyMap<ChannelId, Channel>;
  /** The hobs could not be read, so Direct messages may be missing some. */
  readonly hobsFailed: boolean;
  /** The sections or a hob's channels could not be read, so Camps may be missing some. */
  readonly campsFailed: boolean;
  /** The hobs are still being read, so Direct messages has no rows yet. */
  readonly hobsLoading: boolean;
  /** The sections or a hob's channels are still being read, so Camps has no rows yet. */
  readonly campsLoading: boolean;
  /** Reads again what could not be read. */
  readonly retry: () => void;
}

/**
 * The hub's sections joined with the channels the event stream keeps live per hob, so a row's title
 * and last line follow a reply as it lands while the hub decides which section it is in. A read that
 * failed is never taken for an empty list: the section says so and offers Try again.
 */
export const useSidebarData = (): SidebarData => {
  const read = useQuery(sidebarQuery);
  const agents = useQuery(agentsQuery);
  const hobs = agents.data ?? [];
  const lists = useQueries({ queries: hobs.map((hob) => channelsQuery(hob.id)) });
  const channels = new Map<ChannelId, Channel>(
    lists.flatMap((list) => list.data ?? []).map((channel) => [channel.id, channel] as const),
  );
  const failedLists = lists.filter((list) => list.isError);
  return {
    read: read.data,
    hobs,
    channels,
    hobsLoading: agents.isPending,
    campsLoading: read.isPending || agents.isPending || lists.some((list) => list.isPending),
    hobsFailed: agents.isError,
    campsFailed: read.isError || failedLists.length > 0,
    retry: () => {
      for (const query of [read, agents, ...failedLists]) if (query.isError) void query.refetch();
    },
  };
};
