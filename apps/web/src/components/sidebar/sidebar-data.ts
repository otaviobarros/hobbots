import type { SidebarRead } from "@hobbots/api";
import type { Agent, Thread, ThreadId } from "@hobbots/domain";
import { useQueries, useQuery } from "@tanstack/react-query";
import { agentsQuery, threadsQuery } from "../../api/queries.ts";
import { sidebarQuery } from "../../api/sidebar.ts";

/** What the sidebar shows: the hub's sections, the hobs, and every hob's live threads by id. */
export interface SidebarData {
  readonly read: SidebarRead | undefined;
  readonly hobs: ReadonlyArray<Agent>;
  readonly threads: ReadonlyMap<ThreadId, Thread>;
  /** The hobs could not be read, so Direct messages may be missing some. */
  readonly hobsFailed: boolean;
  /** The sections or a hob's threads could not be read, so Camps may be missing some. */
  readonly campsFailed: boolean;
  /** The hobs are still being read, so Direct messages has no rows yet. */
  readonly hobsLoading: boolean;
  /** The sections or a hob's threads are still being read, so Camps has no rows yet. */
  readonly campsLoading: boolean;
  /** Reads again what could not be read. */
  readonly retry: () => void;
}

/**
 * The hub's sections joined with the threads the event stream keeps live per hob, so a row's title
 * and last line follow a reply as it lands while the hub decides which section it is in. A read that
 * failed is never taken for an empty list: the section says so and offers Try again.
 */
export const useSidebarData = (): SidebarData => {
  const read = useQuery(sidebarQuery);
  const agents = useQuery(agentsQuery);
  const hobs = agents.data ?? [];
  const lists = useQueries({ queries: hobs.map((hob) => threadsQuery(hob.id)) });
  const threads = new Map<ThreadId, Thread>(
    lists.flatMap((list) => list.data ?? []).map((thread) => [thread.id, thread] as const),
  );
  const failedLists = lists.filter((list) => list.isError);
  return {
    read: read.data,
    hobs,
    threads,
    hobsLoading: agents.isPending,
    campsLoading: read.isPending || agents.isPending || lists.some((list) => list.isPending),
    hobsFailed: agents.isError,
    campsFailed: read.isError || failedLists.length > 0,
    retry: () => {
      for (const query of [read, agents, ...failedLists]) if (query.isError) void query.refetch();
    },
  };
};
