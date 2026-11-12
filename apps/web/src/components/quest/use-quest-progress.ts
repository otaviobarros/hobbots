import type { TaskTree } from "@hobbots/domain";
import { useQuestSummary } from "../../api/quest-summaries.ts";
import { type QuestProgress, questProgress } from "./quest-progress.ts";

/** How far a request's work got: its Quest's summary as the hub published it, read with its chat or camp. */
export const useQuestProgress = (tree: TaskTree): QuestProgress => {
  const top = tree.tasks[0];
  const quest = top === undefined ? undefined : tree.quests.find((each) => each.taskId === top.id);
  return questProgress(tree, useQuestSummary(quest ?? null));
};
