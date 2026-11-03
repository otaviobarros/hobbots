import type { NewCheckpoint } from "@hobbots/agents";
import { CheckpointId, descendantsOf, type Quest, type Task, type TaskTree } from "@hobbots/domain";
import { newId } from "./call-scope.ts";

/** How a finding about an empty Quest starts, so it is reported once per Quest. */
const EMPTY_QUEST = "Started a Quest but has not brought anyone in";

/**
 * The finding a member's Task reports when the member's turn ended leaving a Quest it leads with
 * nobody in it and nothing to wait on, so the lead above it hears of it (#576). Null when the Task
 * leads no such Quest, has brought someone in, waits on something under it, or reported it already.
 */
export const emptyQuestFinding = (task: Task, tree: TaskTree, at: string): NewCheckpoint | null => {
  if (task.parentId === null) return null;
  const quest: Quest | undefined = tree.quests.find((each) => each.taskId === task.id && each.state === "active");
  if (quest === undefined) return null;
  const broughtIn = descendantsOf(task, tree.tasks).some((each) => each.ownerId !== task.ownerId);
  const waits = tree.waits.some((wait) => wait.taskId === task.id);
  const reported = tree.checkpoints.some(
    (each) => each.taskId === task.id && each.kind === "finding" && each.summary.startsWith(EMPTY_QUEST),
  );
  if (broughtIn || waits || reported) return null;
  return {
    id: CheckpointId.make(newId()),
    taskId: task.id,
    source: "unplanned",
    kind: "finding",
    milestoneId: null,
    summary: `${EMPTY_QUEST} (Quest ${quest.id}: ${quest.goal}). Its turn ended with nobody delegated to and nothing to wait on.`,
    createdAt: at,
  };
};
