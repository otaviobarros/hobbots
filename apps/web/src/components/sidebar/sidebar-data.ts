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
  readonly failed: boolean;
}

/**
 * The hub's sections joined with the threads the event stream keeps live per hob, so a row's title
 * and last line follow a reply as it lands while the hub decides which section it is in.
 */
export const useSidebarData = (): SidebarData => {
  const read = useQuery(sidebarQuery);
  const agents = useQuery(agentsQuery);
  const hobs = agents.data ?? [];
  const lists = useQueries({ queries: hobs.map((hob) => threadsQuery(hob.id)) });
  const threads = new Map<ThreadId, Thread>(
    lists.flatMap((list) => list.data ?? []).map((thread) => [thread.id, thread] as const),
  );
  return { read: read.data, hobs, threads, failed: agents.isError || read.isError };
};
