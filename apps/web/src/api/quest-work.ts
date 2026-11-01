import type { AgentId, HobbotsEvent, MemberWork } from "@hobbots/domain";
import { type QueryClient, type QueryFunctionContext, queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { syncState } from "./sync.ts";

/** One list per hob, keyed under a shared prefix so a Quest ending can refetch them all. */
export const questWorkKeys = {
  all: ["questWork"] as const,
  of: (agentId: AgentId) => ["questWork", agentId] as const,
};

/** What a hob does on Quests it joined as a party member, oldest first (ADR 018). */
export const questWorkQuery = (agentId: AgentId) =>
  queryOptions({
    queryKey: questWorkKeys.of(agentId),
    ...followsEvents,
    queryFn: async ({ client }: QueryFunctionContext): Promise<ReadonlyArray<MemberWork>> => {
      // A change that arrives while the read is on its way may be missing from it, and a refetch
      // asked for then joins this read instead of starting one, so the read is made again.
      for (;;) {
        const before = mark(client, agentId);
        const read = await call((c) => c.tasks.questWork({ params: { agentId } }));
        if (mark(client, agentId) === before) return read.work;
      }
    },
  });

/** How many changes to Quest work each hob has seen, with `all` counting the ones to every hob. */
const changes = new WeakMap<QueryClient, Map<AgentId | "all", number>>();

const changed = (client: QueryClient, key: AgentId | "all") => {
  const seen = changes.get(client) ?? new Map<AgentId | "all", number>();
  seen.set(key, (seen.get(key) ?? 0) + 1);
  changes.set(client, seen);
};

/** Moves on with every change to `agentId`'s Quest work and with every new sync generation. */
const mark = (client: QueryClient, agentId: AgentId) => {
  const seen = changes.get(client);
  return `${syncState(client).generation}:${seen?.get(agentId) ?? 0}:${seen?.get("all") ?? 0}`;
};

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
  const refetch = (key: AgentId | "all") => {
    changed(queryClient, key);
    void queryClient.invalidateQueries({ queryKey: key === "all" ? questWorkKeys.all : questWorkKeys.of(key) });
  };
  switch (event._tag) {
    case "TaskCreated":
      if (event.delegation) refetch(event.delegation.memberId);
      return;
    case "TaskStateChanged":
      refetch(event.quest ? "all" : event.task.ownerId);
      return;
    case "TaskCompleted":
      refetch(event.task.ownerId);
      return;
    case "QuestCompleted":
      refetch("all");
      return;
    default:
      return;
  }
};
