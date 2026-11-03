import { isTerminalTask, type Task, type TaskId } from "./task.ts";

/**
 * Whether a Task can start an Attempt, read from the Tasks of its tree (ADR 018). It starts only
 * once every Task it comes after has completed. Until then it is `Waiting` on those still under
 * way, or `Blocked` by those that need someone to act first: one that failed or was cancelled, so
 * it never completes by itself, or one that is blocked, such as a step that stopped on a finding
 * for its owner to decide (#667). A Task it comes after that is not in the tree counts as under way.
 */
export type TaskReadiness =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Waiting"; readonly on: ReadonlyArray<TaskId> }
  /** `on` lists every Task it comes after that has not completed; `by`, those of them that hold it. */
  | { readonly _tag: "Blocked"; readonly on: ReadonlyArray<TaskId>; readonly by: ReadonlyArray<TaskId> };

/** A Task it comes after that will not complete until someone acts on it. */
const holds = (before: Task) =>
  before.state === "blocked" || (isTerminalTask(before.state) && before.state !== "completed");

export const TaskReadiness = {
  of: (task: Task, tree: ReadonlyArray<Task>): TaskReadiness => {
    const on: Array<TaskId> = [];
    const by: Array<TaskId> = [];
    for (const id of task.dependsOn) {
      const before = tree.find((each) => each.id === id);
      if (before?.state === "completed") continue;
      on.push(id);
      if (before !== undefined && holds(before)) by.push(id);
    }
    if (by.length > 0) return { _tag: "Blocked", on, by };
    return on.length > 0 ? { _tag: "Waiting", on } : { _tag: "Ready" };
  },

  /** The Tasks it comes after that have not completed, in the order it lists them. */
  unmet: (readiness: TaskReadiness): ReadonlyArray<TaskId> => (readiness._tag === "Ready" ? [] : readiness.on),
};
