import type { AgentId } from "@hobbots/domain";
import type { QuestInProgress } from "./quest-work.ts";

/** A Quest a hob leads, as its page lists it: how far its party got and how many wait on you. */
export interface LedQuest {
  readonly group: QuestInProgress;
  readonly done: number;
  readonly total: number;
  readonly needs: number;
}

/**
 * The Quests a hob leads, split into those still going, the ones that need you first, and those
 * whose every Task is done. Quests keep their order otherwise.
 */
export const ledQuests = (
  quests: ReadonlyArray<QuestInProgress>,
  leadId: AgentId,
): { readonly live: ReadonlyArray<LedQuest>; readonly finished: number } => {
  const led = quests
    .filter((group) => group.quest.leadId === leadId)
    .map((group) => ({
      group,
      done: group.members.filter((each) => each.task.state === "completed").length,
      total: group.members.length,
      needs: group.members.filter((each) => each.task.state === "blocked").length,
    }));
  const live = led.filter((quest) => quest.done < quest.total);
  return {
    live: live.toSorted((a, b) => b.needs - a.needs),
    finished: led.length - live.length,
  };
};
