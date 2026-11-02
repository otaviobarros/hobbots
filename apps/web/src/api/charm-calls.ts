import type { CharmCall, MessageId, ThreadId } from "@hobbots/domain";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
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
