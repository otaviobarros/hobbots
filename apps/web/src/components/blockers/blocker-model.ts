import { type BackpackBlocker, type BackpackItem, openBlocker, type TaskTree } from "@hobbots/domain";
import { firstLine } from "../../lib/format.ts";
import { taskControls } from "../quest/control-room.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** What the stuck work was, in words: the kind of item and the Task it names. */
export const blockerWhat = (item: BackpackItem): string => {
  const payload = item.payload;
  switch (payload._tag) {
    case "task":
    case "result":
    case "failure":
      return copy.what[payload._tag]({ title: firstLine(payload.task.brief) });
    default:
      return copy.what[payload._tag];
  }
};

/** Why it is stuck, in words, with how its last try ended when the hub said. */
export const blockerWhy = (item: BackpackItem, blocker: BackpackBlocker, hobName: string): string => {
  if (blocker.reason === "recipient-retired") return copy.why["recipient-retired"]({ name: hobName });
  const tries = copy.why["retries-exhausted"]({ count: blockerTries(item, blocker) });
  return blocker.lastEnd === null ? tries : `${tries} ${copy.lastEnd[blocker.lastEnd]}`;
};

/** How many times the item was tried in the round that ended in this blocker. */
export const blockerTries = (item: BackpackItem, blocker: BackpackBlocker): number =>
  blocker.afterDeliveries - (item.blockers.find((each) => each.number === blocker.number - 1)?.afterDeliveries ?? 0);

/** The open blockers among `items` about a Task in `taskIds`: the ones a Task card shows. */
export const blockersOn = (
  items: ReadonlyArray<BackpackItem>,
  taskIds: ReadonlySet<string>,
): ReadonlyArray<BackpackItem> =>
  items.filter((item) => openBlocker(item) !== undefined && item.taskId !== null && taskIds.has(item.taskId));

/**
 * The stuck item's Task, in the tree of the thread it belongs to, while that Task can change hands:
 * the same rule the lane's ⋯ menu offers Reassign… by (#1087). Null otherwise, or until the
 * thread's Tasks are read.
 */
export const reassignable = (trees: ReadonlyArray<TaskTree>, item: BackpackItem) => {
  for (const tree of trees) {
    const task = tree.tasks.find((each) => each.id === item.taskId);
    if (task !== undefined) return taskControls(tree, task).reassign ? { tree, task } : null;
  }
  return null;
};
