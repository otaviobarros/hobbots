import type { SkillHealth, SkillTrialDraftPayload, SkillTrialText } from "@hobbots/api";
import type { AgentId, Channel, ChannelId } from "@hobbots/domain";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";
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
    onSuccess: (channel: Channel) => {
      queryClient.setQueryData<ReadonlyArray<Channel>>(queryKeys.channels(channel.agentId), (old) =>
        old === undefined || old.some((one) => one.id === channel.id) ? old : [channel, ...old],
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

/**
 * The draft a chat tries, as it was tried, so its editor opens on it again. A draft never changes, so
 * it is read once; gone when the hub no longer has it, as after a restore.
 */
export const skillTrialDraftQuery = (channelId: ChannelId) =>
  queryOptions({
    queryKey: ["skills", "trial", channelId] as const,
    queryFn: (): Promise<SkillTrialText> => call((c) => c.skillTrials.draft({ params: { channelId } })),
    staleTime: Number.POSITIVE_INFINITY,
    // A draft the hub no longer has stays gone; any other failure is tried again.
    retry: (count, error) => !draftGone(error) && count < 2,
  });

/** Whether a read of a tried draft failed because the hub no longer has it, not on the way there. */
export const draftGone = (error: unknown): boolean => error instanceof ApiError && error.tag === "SkillDraftGone";
