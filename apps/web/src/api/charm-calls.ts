import type { WaitingCharmCall } from "@hobbots/api";
import type { CharmCall, MessageId, TaskId, ThreadId } from "@hobbots/domain";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

const charmCallsKey = (threadId: ThreadId) => ["threads", threadId, "charm-calls"] as const;

/**
 * The thread's Charm calls, such as GitHub pushes, oldest first (ADR 020). An uncertain one is read
 * back on GitHub in the background, so the list is read again every half minute while one is.
 */
export const charmCallsQuery = (threadId: ThreadId) =>
  queryOptions({
    queryKey: charmCallsKey(threadId),
    queryFn: () => call((c) => c.charmCalls.forThread({ params: { threadId } })),
    refetchInterval: (query) =>
      query.state.data?.some((charmCall) => charmCall.state === "uncertain" || charmCall.state === "sending")
        ? 30_000
        : false,
  });

/** Settles the uncertain call a reply step showed as, once the user has looked on GitHub. */
export const useSettleCharmCall = (threadId: ThreadId, messageId: MessageId, stepId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (outcome: "applied" | "not-sent") =>
      call((c) => c.charmCalls.settle({ params: { threadId, messageId, stepId }, payload: { outcome } })),
    onSuccess: (settled: CharmCall) =>
      queryClient.setQueryData<ReadonlyArray<CharmCall>>(charmCallsKey(threadId), (old) =>
        old?.map((existing) =>
          existing.key === settled.key && existing.agentId === settled.agentId ? settled : existing,
        ),
      ),
    // Settled elsewhere, or by reading GitHub back: show it as the hub has it now.
    onError: () => queryClient.invalidateQueries({ queryKey: charmCallsKey(threadId), exact: true }),
  });
};

const waitingKey = ["charm-calls", "waiting"] as const;

/**
 * The Charm writes on Tasks whose answer is still uncertain after the last read-back, each with its
 * Task (ADR 038): they wait on the user in their quest and the Inbox. A call turns uncertain with
 * no event to follow, so the list is read again every half minute.
 */
export const waitingCharmCallsQuery = queryOptions({
  queryKey: waitingKey,
  queryFn: () => call((c) => c.charmCalls.waiting()),
  refetchInterval: 30_000,
});

const NO_CALLS: ReadonlyArray<WaitingCharmCall> = [];

/** The uncertain Charm writes on Tasks; none until read. */
export const useWaitingCharmCalls = (): ReadonlyArray<WaitingCharmCall> =>
  useQuery(waitingCharmCallsQuery).data ?? NO_CALLS;

/** Settles an uncertain write a Task made, by the Task and the sending it was, once the user has looked on GitHub. */
export const useSettleTaskCharmCall = (taskId: TaskId, attempt: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (outcome: "applied" | "not-sent") =>
      call((c) => c.charmCalls.settleOnTask({ params: { taskId, attempt }, payload: { outcome } })),
    // Settled here, elsewhere, or by reading GitHub back: it leaves the list either way.
    onSettled: () => queryClient.invalidateQueries({ queryKey: waitingKey, exact: true }),
  });
};
