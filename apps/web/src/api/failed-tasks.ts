import type { FailedTask, Task } from "@hobbots/domain";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { syncState } from "./sync.ts";

const failedKey = ["tasks", "failed"] as const;

/**
 * Party members' Tasks that failed while their work goes on (ADR 027), oldest first, each with the
 * lead you talk to about it: each puts a needs-you mark on that lead's tile until it is retried,
 * reassigned or its work ends. A read that lands after a new sync generation began is taken again.
 */
export const failedTasksQuery = queryOptions({
  queryKey: failedKey,
  queryFn: async ({ client }): Promise<ReadonlyArray<FailedTask>> => {
    const state = syncState(client);
    for (;;) {
      const generation = state.generation;
      const read = await call((c) => c.tasks.failed());
      if (state.generation === generation) return read.tasks;
    }
  },
  ...followsEvents,
});

/**
 * A Task changed: one that failed joins the list, and one in it that moved on, or whose top Task
 * ended, leaves it, so the list is read again then. A read on its way may have been taken before
 * the change, so it is read again too. Other changes leave it as it is.
 */
export const failedTaskChanged = async (queryClient: QueryClient, task: Task): Promise<void> => {
  const listed = queryClient.getQueryData<ReadonlyArray<FailedTask>>(failedKey) ?? [];
  const about = listed.some((each) => each.task.id === task.id || each.task.rootId === task.id);
  const reading = queryClient.isFetching({ queryKey: failedKey, exact: true }) > 0;
  if (task.state !== "failed" && !about && !reading) return;
  // A read already on its way may have been taken before the change.
  await queryClient.cancelQueries({ queryKey: failedKey, exact: true });
  await queryClient.invalidateQueries({ queryKey: failedKey, exact: true });
};

const NONE: ReadonlyArray<FailedTask> = [];

/** The read of the failed Tasks that wait on you, with its loading and failure states. */
export const useFailedTasksQuery = () => useQuery(failedTasksQuery);

/** The failed Tasks that wait on you; none until read. */
export const useFailedTasks = (): ReadonlyArray<FailedTask> => useFailedTasksQuery().data ?? NONE;
