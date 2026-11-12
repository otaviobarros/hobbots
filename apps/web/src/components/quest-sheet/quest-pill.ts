import type { QuestSummary, ThreadId } from "@hobbots/domain";

/** What a camp's quest pill says (ADR 037): its quests under way, what is ready for review and what needs you. */
export interface QuestPill {
  readonly quests: number;
  readonly review: number;
  readonly needs: number;
}

/**
 * The pill for the quests a camp started, from the summaries the hub publishes and never from Task
 * states (STD-REACT-028): each quest still under way that the camp started itself, not a Quest a
 * member leads inside one, which its lead's quest already counts. Null while none is under way.
 */
export const questPill = (threadId: ThreadId, summaries: ReadonlyArray<QuestSummary>): QuestPill | null => {
  const running = summaries.filter(
    (summary) => summary.threadId === threadId && summary.parentQuestId === null && summary.state === "active",
  );
  if (running.length === 0) return null;
  return {
    quests: running.length,
    review: running.reduce((sum, summary) => sum + summary.readyForReview, 0),
    needs: running.reduce((sum, summary) => sum + summary.needsYou, 0),
  };
};
