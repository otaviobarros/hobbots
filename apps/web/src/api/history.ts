import type { AgentId, HistoryFilter, HistoryPage, HobbotsEvent } from "@hobbots/domain";
import { type QueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { DateTime } from "effect";
import { call } from "./client.ts";

/** Each hob's History, one list per filter, under a shared prefix so any change can refetch them all. */
const historyKeys = {
  all: ["history"] as const,
  of: (agentId: AgentId, filter: HistoryFilter) => ["history", agentId, filter] as const,
};

/** The reader's own time zone, which decides where each day of the History starts. */
const readerZone = () => DateTime.zoneMakeNamedUnsafe(Intl.DateTimeFormat().resolvedOptions().timeZone);

/**
 * What a hob did across all its chats, newest first, a page of days at a time. The next page starts
 * before the oldest event of the last one; it is null when there are no earlier days.
 */
export const useHobHistory = (agentId: AgentId, filter: HistoryFilter) =>
  useInfiniteQuery({
    queryKey: historyKeys.of(agentId, filter),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<HistoryPage> => {
      const read = await call((c) =>
        c.tasks.history({
          params: { agentId },
          query: {
            timeZone: readerZone(),
            filter,
            ...(pageParam === null ? {} : { before: DateTime.makeUnsafe(pageParam) }),
          },
        }),
      );
      return read.page;
    },
    getNextPageParam: (last) => last.before,
  });

/** The events a History is read from: Tasks, Quests, approvals and questions. */
const CHANGES_HISTORY = new Set<HobbotsEvent["_tag"]>([
  "TaskCreated",
  "TaskStateChanged",
  "TaskCompleted",
  "QuestStarted",
  "QuestCompleted",
  "ApprovalRequested",
  "ApprovalResolved",
  "QuestionAsked",
  "QuestionAnswered",
  "QuestionEscalated",
  "QuestionWithdrawn",
]);

/** Keeps each History fresh: a change to its records reads the open ones again. */
export const applyHistory = (queryClient: QueryClient, event: HobbotsEvent) => {
  if (CHANGES_HISTORY.has(event._tag)) void queryClient.invalidateQueries({ queryKey: historyKeys.all });
};
