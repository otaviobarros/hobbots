import type { AgentId, QuestId, QuestSummary } from "@hobbots/domain";
import type { QuestInProgress } from "./quest-work.ts";

/** A Quest a hob leads, as its page lists it: how far it got and how many things wait on you, as the hub counts them. */
export interface LedQuest {
  readonly group: QuestInProgress;
  readonly done: number;
  readonly total: number;
  readonly needs: number;
}

/** How many Tasks under a Quest's own are done, of how many, from its summary (ADR 037). */
export const summaryProgress = (summary: QuestSummary): { readonly done: number; readonly total: number } => ({
  done: summary.tones.done,
  total: Object.values(summary.tones).reduce((sum, count) => sum + count, 0),
});

/**
 * The Quests a hob leads, split into those still going, the ones that need you first, and those
 * whose every Task is done. Each reads its counts from the hub's summary, and a Quest whose summary
 * has not been read yet waits for it. Quests keep their order otherwise.
 */
export const ledQuests = (
  quests: ReadonlyArray<QuestInProgress>,
  summaries: ReadonlyMap<QuestId, QuestSummary>,
  leadId: AgentId,
): { readonly live: ReadonlyArray<LedQuest>; readonly finished: number } => {
  const led = quests.flatMap((group) => {
    const summary = summaries.get(group.quest.id);
    if (group.quest.leadId !== leadId || summary === undefined) return [];
    return [{ group, ...summaryProgress(summary), needs: summary.needsYou }];
  });
  const live = led.filter((quest) => quest.done < quest.total);
  return {
    live: live.toSorted((a, b) => b.needs - a.needs),
    finished: led.length - live.length,
  };
};
