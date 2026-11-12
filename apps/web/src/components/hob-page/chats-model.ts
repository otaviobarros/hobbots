import {
  type ApprovalRequest,
  type QuestId,
  type QuestSummary,
  type SearchHit,
  type SnippetPart,
  searchTerms,
  snippetOf,
  THREAD_TITLE_MAX,
  type Thread,
} from "@hobbots/domain";
import { summaryProgress } from "../../lib/led-quests.ts";
import type { QuestInProgress } from "../../lib/quest-work.ts";
import { messages } from "./messages.ts";

/** The groups a hob's chats sit in, in the order they show. */
export type ChatGroup = "pinned" | "today" | "week" | "older";

/** How many Older chats show before Show N older chats. */
export const OLDER_SHOWN = 5;

const DAY = 24 * 60 * 60 * 1000;

/** The group a chat falls in: pinned first, then by its last activity in local time. */
export const groupOf = (thread: Pick<Thread, "pinnedAt" | "updatedAt">, now: Date): ChatGroup => {
  if (thread.pinnedAt !== null) return "pinned";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = new Date(thread.updatedAt).getTime();
  if (at >= today) return "today";
  return at >= today - 6 * DAY ? "week" : "older";
};

/**
 * The hob's chats in their groups, each newest first, leaving out empty groups. Pinned chats come
 * first, most recently pinned on top.
 */
export const chatGroups = <T extends Pick<Thread, "pinnedAt" | "updatedAt">>(
  threads: ReadonlyArray<T>,
  now: Date,
): ReadonlyArray<{ readonly group: ChatGroup; readonly threads: ReadonlyArray<T> }> => {
  const byGroup = (group: ChatGroup) =>
    threads
      .filter((thread) => groupOf(thread, now) === group)
      .sort((a, b) =>
        group === "pinned"
          ? (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "")
          : b.updatedAt.localeCompare(a.updatedAt),
      );
  return (["pinned", "today", "week", "older"] as const)
    .map((group) => ({ group, threads: byGroup(group) }))
    .filter(({ threads: list }) => list.length > 0);
};

/** A chat that matched a search: its title with the matching words marked, and a matching message. */
export interface ChatMatch<T> {
  readonly thread: T;
  readonly title: ReadonlyArray<SnippetPart>;
  readonly snippet: ReadonlyArray<SnippetPart> | null;
}

const matchesTitle = (title: ReadonlyArray<SnippetPart>) => title.some((part) => part.match);

/**
 * The hob's live chats that match `query`, newest first: by their title, here, or by their
 * messages, from the hub's search. Archived chats are left to the Archive.
 */
export const chatMatches = <T extends Pick<Thread, "id" | "title" | "updatedAt">>(
  threads: ReadonlyArray<T>,
  hits: ReadonlyArray<Pick<SearchHit, "thread" | "matches">>,
  query: string,
): ReadonlyArray<ChatMatch<T>> => {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const byThread = new Map(hits.map((hit) => [hit.thread.id, hit] as const));
  return threads
    .map((thread) => {
      const title = snippetOf(thread.title, terms, THREAD_TITLE_MAX * 2);
      const snippet = byThread.get(thread.id)?.matches[0]?.snippet ?? null;
      return { thread, title, snippet };
    })
    .filter((match) => matchesTitle(match.title) || match.snippet !== null)
    .sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
};

/** How many approvals wait for you in each chat. */
export const waitingByThread = (
  approvals: ReadonlyArray<Pick<ApprovalRequest, "threadId" | "state">>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const approval of approvals) {
    if (approval.state === "pending") counts.set(approval.threadId, (counts.get(approval.threadId) ?? 0) + 1);
  }
  return counts;
};

/**
 * The Quests each chat follows, as its row's chips: the goal and how many of its Tasks are done, as
 * the hub's summary counts them (ADR 037). A nested Quest followed in the same chat gets a chip of
 * its own; a Quest whose summary is not read yet waits for it.
 */
export const questsByThread = (
  quests: ReadonlyArray<QuestInProgress>,
  summaries: ReadonlyMap<QuestId, QuestSummary>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const chips = new Map<string, Array<string>>();
  for (const { quest } of quests) {
    const summary = summaries.get(quest.id);
    if (quest.threadId === null || summary === undefined) continue;
    const chip = messages.chats.quest({ goal: quest.goal, ...summaryProgress(summary) });
    chips.set(quest.threadId, [...(chips.get(quest.threadId) ?? []), chip]);
  }
  return chips;
};

/** A typed title as it is saved: one line, trimmed and cut to the longest title; null when empty. */
export const cleanTitle = (typed: string): string | null => {
  const line = typed.replace(/\s+/g, " ").trim().slice(0, THREAD_TITLE_MAX).trim();
  return line === "" ? null : line;
};
