import type { TaskTree } from "./quest.ts";
import { ancestorsOf, descendantsOf, isLiveAttempt, isTerminalTask, type Task } from "./task.ts";

/** What a cancel moves a Task to: confirmed at once when nothing runs in it, requested otherwise. */
export interface CancelMove {
  readonly task: Task;
  readonly to: "cancelled" | "cancelling";
}

/**
 * The moves that cancel `target` and everything under it (OR-006), deepest first, so a Task ends
 * only after what is under it. A Task that has ended, or whose cancel was asked for already, is
 * left as it is. A queued Task with no live Attempt and nothing open under it is confirmed at once;
 * every other is asked to stop, and the runner confirms it once it has.
 */
export const cancelMoves = (target: Task, tree: TaskTree): ReadonlyArray<CancelMove> => {
  const live = new Set(tree.attempts.filter((each) => isLiveAttempt(each.state)).map((each) => each.id as string));
  const states = new Map(tree.tasks.map((each) => [each.id, each.state]));
  const deepestFirst = [target, ...descendantsOf(target, tree.tasks)]
    .map((each) => ({ each, depth: ancestorsOf(each, tree.tasks).length }))
    .sort((a, b) => b.depth - a.depth)
    .map(({ each }) => each);
  const moves: Array<CancelMove> = [];
  for (const task of deepestFirst) {
    const state = states.get(task.id);
    if (state === undefined || isTerminalTask(state) || state === "cancelling") continue;
    const quiet =
      state === "queued" &&
      (task.currentAttemptId === null || !live.has(task.currentAttemptId)) &&
      descendantsOf(task, tree.tasks).every((each) => {
        const under = states.get(each.id);
        return under !== undefined && isTerminalTask(under);
      });
    const to = quiet ? "cancelled" : "cancelling";
    states.set(task.id, to);
    moves.push({ task, to });
  }
  return moves;
};
