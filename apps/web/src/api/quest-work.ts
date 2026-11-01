import type { AgentId, HobbotsEvent, MemberWork } from "@hobbots/domain";
import { type QueryClient, queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { call } from "./client.ts";

/** A hob's Tasks on other hobs' Quests sit under the hob, so dropping a hob drops them too. */
export const questWorkKeys = {
  all: ["questWork"] as const,
  of: (agentId: AgentId) => ["questWork", agentId] as const,
};

/** What a hob does on Quests it joined as a party member, oldest first (ADR 018). */
const questWorkQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: questWorkKeys.of(agentId),
    queryFn: async (): Promise<ReadonlyArray<MemberWork>> =>
      (await call((c) => c.tasks.questWork({ params: { agentId } }))).work,
  });

/** One hob's Quest work, for its row in the hob panel. */
export const useHobQuestWork = (agentId: AgentId) => useQuery(questWorkQuery(agentId)).data ?? [];

/** Every listed hob's Quest work, for Home. */
export const useQuestWork = (agentIds: ReadonlyArray<AgentId>): ReadonlyArray<MemberWork> =>
  useQueries({
    queries: agentIds.map(questWorkQuery),
    combine: (results) => results.flatMap((result) => result.data ?? []),
  });

/**
 * Keeps Quest work fresh from the event stream. A member's Task changing refetches that member's
 * list; a Quest ending can drop work from any member's list, so it refetches them all.
 */
export const applyQuestWork = (queryClient: QueryClient, event: HobbotsEvent) => {
  const refetch = (queryKey: ReadonlyArray<string>) => void queryClient.invalidateQueries({ queryKey });
  switch (event._tag) {
    case "TaskCreated":
      if (event.delegation) refetch(questWorkKeys.of(event.delegation.memberId));
      return;
    case "TaskStateChanged":
      refetch(event.quest ? questWorkKeys.all : questWorkKeys.of(event.task.ownerId));
      return;
    case "TaskCompleted":
      refetch(questWorkKeys.of(event.task.ownerId));
      return;
    case "QuestCompleted":
      refetch(questWorkKeys.all);
      return;
    default:
      return;
  }
};
