import type { SkillHealth, SkillTrialDraftPayload } from "@hobbots/api";
import type { AgentId, Thread } from "@hobbots/domain";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { queryKeys } from "./queries.ts";

/**
 * Try in a chat and the Overview's health checks (ADR 029, #1099). A trial is a new chat with one hob
 * where only the draft is loaded; nothing about the draft reaches the library.
 */

/** Opens a new chat with `agentId` that loads only `draft`, and answers it once the hub made it. */
export const useStartTrial = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly agentId: AgentId; readonly draft: SkillTrialDraftPayload }) =>
      call((c) => c.skillTrials.start({ payload: input })),
    onSuccess: (thread: Thread) => {
      queryClient.setQueryData<ReadonlyArray<Thread>>(queryKeys.threads(thread.agentId), (old) =>
        old === undefined || old.some((one) => one.id === thread.id) ? old : [thread, ...old],
      );
    },
  });
};

/**
 * What in the library deserves a look, and what each hob carries. Worked out from uses and every
 * hob's folders, which no event announces each of, so it is read again a minute after it was.
 */
export const skillHealthQuery = queryOptions({
  queryKey: ["skills", "health"] as const,
  queryFn: (): Promise<SkillHealth> => call((c) => c.skillHealth.get()),
  staleTime: 60_000,
});
