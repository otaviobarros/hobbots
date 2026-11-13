import type { TaskTree } from "./quest.ts";
import { ancestorsOf, descendantsOf, type PausedFrom, type Task, TaskPauses } from "./task.ts";

/**
 * Pause, Pause now and Resume for a Quest or a Task (#1446): a pause holds the Task and everything
 * under it, so no turn starts there until you resume it. These pure rules pick the Tasks each
 * command moves, and what Resume tells each hob that goes back to work.
 */

/** The Tasks a pause of `target` moves, top first: it and every Task under it still under way. */
export const pauseTargets = (target: Task, tree: TaskTree): ReadonlyArray<Task> =>
  [target, ...descendantsOf(target, tree.tasks)].filter(TaskPauses.canPause);

/** The Tasks a resume of `target` moves, top first: it and every Task under it you paused. */
export const resumeTargets = (target: Task, tree: TaskTree): ReadonlyArray<Task> =>
  [target, ...descendantsOf(target, tree.tasks)].filter(TaskPauses.isPaused);

/** The paused Task above `task` that still holds it, which a resume of `task` alone would not lift. */
export const pausedAbove = (task: Task, tree: TaskTree): Task | undefined =>
  ancestorsOf(task, tree.tasks).find(TaskPauses.isPaused);

/**
 * Where a Task whose paused turn ended without its runner to settle it goes back to on Resume, as
 * after a restart (#1446): the Task you asked for to its chat, a step to the queue, which starts it
 * afresh, and a member's Task to waiting, which Resume's note wakes. As `turnEnded` decides it.
 */
export const resumedAs = (task: Task, tree: ReadonlyArray<Task>): PausedFrom => {
  if (task.parentId === null) return "active";
  const parent = tree.find((each) => each.id === task.parentId);
  return parent?.ownerId === task.ownerId ? "queued" : "waiting";
};

/** Whether Pause now stopped a turn on `task`: an Attempt of it was stopped at or after `at`. */
const stoppedBy = (task: Task, tree: TaskTree, at: string) =>
  tree.attempts.some(
    (each) => each.taskId === task.id && each.state === "interrupted" && each.endedAt !== null && each.endedAt >= at,
  );

/** Most Tasks a resume note lists as changed, so it stays short. */
const CHANGES_LIMIT = 8;

/**
 * The Tasks a resume tells about, one per hob: the highest resumed Task each hob owns, so a member
 * hears once, on its own Task, and the lead on the Task it leads. `resumed` lists them top first.
 */
export const resumeRecipients = (resumed: ReadonlyArray<Task>): ReadonlyArray<Task> => {
  const seen = new Set<string>();
  return resumed.filter((task) => {
    if (seen.has(task.ownerId)) return false;
    seen.add(task.ownerId);
    return true;
  });
};

/**
 * What Resume tells the hob that owns `task` (#1446), read from the records: when the work was
 * paused and resumed, whether Pause now stopped its turn, and each other Task whose state moved
 * since the pause. `before` is the Task as it was paused.
 */
export const resumeNote = (before: Task, tree: TaskTree, at: string): string => {
  const pause = before.pause;
  const since = pause?.at ?? before.updatedAt;
  const changed = tree.tasks
    // What the resume itself moves back is no news.
    .filter((each) => each.id !== before.id && each.updatedAt > since && !TaskPauses.isPaused(each))
    .map((each) => `Task ${each.id} (${each.ownerId}) is ${each.state}`);
  const lines = [
    `The user paused this work at ${since} and resumed it at ${at}. Carry on from where it stands.`,
    ...(pause?.now === true && stoppedBy(before, tree, pause.at)
      ? ["Your turn was stopped when it was paused, so check what it finished before going on."]
      : []),
    changed.length === 0
      ? "Nothing else in the work changed while it was paused."
      : `While it was paused: ${changed.slice(0, CHANGES_LIMIT).join("; ")}${
          changed.length > CHANGES_LIMIT ? `; and ${changed.length - CHANGES_LIMIT} more` : ""
        }.`,
  ];
  return lines.join(" ");
};
