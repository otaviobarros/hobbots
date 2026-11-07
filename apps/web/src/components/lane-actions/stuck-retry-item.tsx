import { type BackpackItem, isTerminalTask, openBlocker, type Task, type TaskTree } from "@hobbots/domain";
import { DropdownMenuItem } from "@hobbots/ui/components/menu";
import { useBlockers } from "../../api/blockers.ts";
import { blockerChoice } from "../blockers/blocker-choices.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import type { LaneActions } from "./use-lane-actions.ts";

/** Stuck work about one of a lane's Tasks that Retry can send again, with the Task it is about. */
export interface StuckRetry {
  readonly task: Task;
  readonly item: BackpackItem;
  readonly blocker: number;
}

/**
 * The stuck work on any of the lane hob's Tasks that have not ended, the header's Task first, that
 * Retry can send again: its hob ran out of tries and has not retired. A lane says Stuck for any of
 * them, so its menu offers Retry for each, as their cards do (#1087).
 */
export const stuckRetries = (
  tree: TaskTree,
  lane: Task,
  blockers: ReadonlyArray<BackpackItem>,
  hobs: HobLookup,
): ReadonlyArray<StuckRetry> =>
  tree.tasks
    .filter((each) => each.ownerId === lane.ownerId && !isTerminalTask(each.state))
    .sort((a, b) => Number(b.id === lane.id) - Number(a.id === lane.id))
    .flatMap((task) =>
      blockers.flatMap((item) => {
        const blocker = item.taskId === task.id ? openBlocker(item) : undefined;
        if (blocker === undefined || blockerChoice(item, hobs(task.ownerId))?.retired !== false) return [];
        return [{ task, item, blocker: blocker.number }];
      }),
    );

export const useStuckRetries = (tree: TaskTree, lane: Task, hobs: HobLookup) =>
  stuckRetries(tree, lane, useBlockers(), hobs);

/**
 * Retry on each piece of stuck work in the lane: a fresh set of tries, as Retry on its card sends.
 * With more than one, each names its Task. What the hub answers shows in the lane, under that Task.
 */
export function StuckRetryItems({ stuck, actions }: { stuck: ReadonlyArray<StuckRetry>; actions: LaneActions }) {
  return stuck.map(({ task, item, blocker }) => (
    <DropdownMenuItem key={item.id} disabled={actions.busy} onSelect={() => actions.retryStuck(task.id, item, blocker)}>
      {stuck.length === 1 ? messages.retry : messages.retryTask({ title: taskTitle(task) })}
    </DropdownMenuItem>
  ));
}
