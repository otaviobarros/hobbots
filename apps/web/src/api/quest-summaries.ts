import type { Quest, QuestId, QuestSummary, ThreadId } from "@hobbots/domain";
import { type QueryClient, type QueryFunctionContext, queryOptions, useQuery } from "@tanstack/react-query";
import { call } from "./client.ts";
import { followsEvents } from "./queries.ts";
import { syncState } from "./sync.ts";

/**
 * How each Quest is going, as the hub publishes it (ADR 037): the quest pill, the room and a hob's
 * page read these and never fold Task states themselves (STD-REACT-028). A summary is kept by Quest,
 * ended ones too, so an older read never brings back what a newer `QuestSummaryChanged` replaced.
 */
export type Summaries = Readonly<Record<QuestId, QuestSummary>>;

const questSummaryKeys = {
  active: ["quest-summaries", "active"] as const,
  of: (threadId: ThreadId) => ["quest-summaries", "thread", threadId] as const,
};

/** How many summaries this client has taken from events: a read that missed one is made again. */
const changes = new WeakMap<QueryClient, number>();
const mark = (client: QueryClient) => `${syncState(client).generation}:${changes.get(client) ?? 0}`;

/** Each summary of either set, the newer of the two where both hold one. */
const merged = (held: Summaries | undefined, read: ReadonlyArray<QuestSummary>): Summaries => {
  const next: Record<QuestId, QuestSummary> = { ...held };
  for (const summary of read) {
    const known = next[summary.questId];
    if (known === undefined || known.revision < summary.revision) next[summary.questId] = summary;
  }
  return next;
};

const summariesQuery = (queryKey: ReadonlyArray<string>, threadId: ThreadId | undefined) =>
  queryOptions({
    queryKey,
    ...followsEvents,
    queryFn: async ({ client }: QueryFunctionContext): Promise<Summaries> => {
      for (;;) {
        const before = mark(client);
        const read = await call((c) => c.tasks.questSummaries({ query: threadId === undefined ? {} : { threadId } }));
        if (mark(client) === before) return merged(client.getQueryData<Summaries>(queryKey), read.summaries);
      }
    },
  });

/** Every Quest still active, and those that ended since they were read. */
export const activeSummariesQuery = summariesQuery(questSummaryKeys.active, undefined);

/** Every Quest followed in a chat or camp, ended ones included. */
const threadSummariesQuery = (threadId: ThreadId) => summariesQuery(questSummaryKeys.of(threadId), threadId);

/**
 * A Quest's summary changed: every loaded set that holds the Quest, or would, takes it when it is
 * newer. A set not loaded yet reads it with its first read.
 */
export const questSummaryChanged = (queryClient: QueryClient, summary: QuestSummary) => {
  changes.set(queryClient, (changes.get(queryClient) ?? 0) + 1);
  const take = (old: Summaries | undefined) => (old === undefined ? old : merged(old, [summary]));
  queryClient.setQueryData<Summaries>(questSummaryKeys.active, take);
  if (summary.threadId !== null) queryClient.setQueryData<Summaries>(questSummaryKeys.of(summary.threadId), take);
};

const byQuest = (summaries: Summaries): ReadonlyMap<QuestId, QuestSummary> =>
  new Map(Object.values(summaries).map((summary) => [summary.questId, summary]));
const NO_SUMMARIES: ReadonlyMap<QuestId, QuestSummary> = new Map();

/** Every summary read with the active Quests, by Quest, including those that ended since. */
export const useSummariesByQuest = (): ReadonlyMap<QuestId, QuestSummary> =>
  useQuery({ ...activeSummariesQuery, select: byQuest }).data ?? NO_SUMMARIES;

/**
 * A Quest's summary, read with the Quests of the chat or camp it is followed in; undefined until
 * read, and for no Quest, as for a Task that works alone.
 */
export const useQuestSummary = (quest: Pick<Quest, "id" | "threadId"> | null): QuestSummary | undefined =>
  useQuery({
    ...(quest?.threadId == null ? activeSummariesQuery : threadSummariesQuery(quest.threadId)),
    enabled: quest !== null,
    select: (summaries: Summaries) => (quest === null ? undefined : summaries[quest.id]),
  }).data;
