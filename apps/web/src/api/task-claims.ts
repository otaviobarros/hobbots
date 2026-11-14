import { type Claim, isTerminalTask, type Task, type TaskId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";

// A Task's files and branches as the claims register holds them (ADR 037), and Take over, which
// moves them to you so the hub refuses its hob's writes to them (#1449).

const taskClaimsKey = (taskId: TaskId) => ["task-claims", taskId] as const;

/** A Task's open claims, oldest first; the `Claim*` events say when to read them again. */
const taskClaimsQuery = (taskId: TaskId) =>
  queryOptions({
    queryKey: taskClaimsKey(taskId),
    queryFn: () => call((c) => c.claims.taskClaims({ params: { taskId } })),
    ...followsEvents,
  });

/** A Task's open claims while it can still be taken over; an ended Task holds none. */
export const useTaskClaims = (task: Task) =>
  useQuery({ ...taskClaimsQuery(task.id), enabled: !isTerminalTask(task.state) });

/** A claim was made, contested, cleared, taken over or released: every Task's claims are read again. */
export const refreshTaskClaims = async (queryClient: QueryClient): Promise<void> => {
  await queryClient.cancelQueries({ queryKey: ["task-claims"] });
  await queryClient.invalidateQueries({ queryKey: ["task-claims"] });
};

/**
 * Takes over a Task's files and branches. The hub answers with the claims it moved to you, which
 * the Task's read shows at once, before their events arrive.
 */
export const useTakeOver = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: TaskId): Promise<ReadonlyArray<Claim>> =>
      call((c) => c.claims.takeOver({ params: { taskId } })),
    onSuccess: (_taken, taskId) => queryClient.invalidateQueries({ queryKey: taskClaimsKey(taskId) }),
  });
};
