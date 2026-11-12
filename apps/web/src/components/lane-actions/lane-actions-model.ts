import type { WaitingCharmCall } from "@hobbots/api";
import { type Attempt, type AttemptId, type Question, saysMore, type Task, type TaskTree } from "@hobbots/domain";
import { taskControls, topCancel } from "../quest/control-room.ts";
import { questionForYou } from "../quest/work-model.ts";

/**
 * What you can do from a hob's work in a quest (ADR 027), from the Task tree alone: the ⋯
 * menu's items, the tries in the attempt picker, the question that waits for you and why a failed
 * Task stopped. The controls act on the Task directly, never through the lead (OR-006).
 */

/** The ⋯ menu on a lane: what it offers for the Task its header names and the hob's other work. */
export interface LaneMenu {
  /** A failed Task runs again as a new Attempt. */
  readonly retry: boolean;
  /** A member's Task goes to another hob, keeping its history. */
  readonly reassign: boolean;
  /**
   * The hob's Tasks on the Quest that Cancel task… can stop, each with everything under it, steps
   * included: the lane's header Task first, then the rest in tree order. The Quest's top Task is
   * never one: the lead's lane cancels it as the whole request.
   */
  readonly cancel: ReadonlyArray<Task>;
  /** The lead's lane pins its Quest in every thread. */
  readonly pin: boolean;
  /**
   * The lead's lane cancels the whole request while it runs: its Quest, or its Task while no party
   * joined. Null on a member's lane and once the request ended.
   */
  readonly cancelTop: "quest" | "task" | null;
}

export const laneMenu = (tree: TaskTree, task: Task): LaneMenu => {
  const top = tree.tasks[0];
  const lead = top !== undefined && task.id === top.id;
  const controls = taskControls(tree, task);
  const cancel = tree.tasks
    .filter((each) => each.ownerId === task.ownerId && taskControls(tree, each).cancel)
    .sort((a, b) => Number(b.id === task.id) - Number(a.id === task.id));
  const quest = lead && tree.quests.some((each) => each.taskId === task.id);
  return {
    retry: controls.retry,
    reassign: controls.reassign,
    cancel,
    pin: lead,
    cancelTop: lead && topCancel(tree) === "open" ? (quest ? "quest" : "task") : null,
  };
};

/** A try in a lane's attempt picker: "Try 1 ✗ · 2". */
export interface LaneTry {
  readonly attempt: Attempt;
  /** The try ended without finishing the work: it failed, was interrupted or never confirmed it stopped. */
  readonly failed: boolean;
  /** The try the lane and the Workbench show. */
  readonly picked: boolean;
}

/** A Task's Attempts, first to last. */
const triesOf = (tree: TaskTree, task: Task): ReadonlyArray<Attempt> =>
  tree.attempts.filter((each) => each.taskId === task.id).sort((a, b) => a.number - b.number);

const FAILED: ReadonlyArray<Attempt["state"]> = ["failed", "interrupted", "unresolved"];

/**
 * A Task's tries, first to last, once it has more than one; none before that, so the picker shows
 * only when there is a choice. `picked` is the try the address names; with none, or one of another
 * Task, the latest is shown.
 */
export const laneTries = (tree: TaskTree, task: Task, picked: AttemptId | undefined): ReadonlyArray<LaneTry> => {
  const attempts = triesOf(tree, task);
  if (attempts.length < 2) return [];
  const shown = attempts.find((each) => each.id === picked) ?? attempts[attempts.length - 1];
  return attempts.map((attempt) => ({
    attempt,
    failed: FAILED.includes(attempt.state),
    picked: attempt.id === shown?.id,
  }));
};

/** An earlier try picked in the lane's picker: which it was, and where it left the Task. */
export interface PickedTry {
  readonly number: number;
  /** The last thing the try reported, else how it ended; null while it said nothing. */
  readonly line: string | null;
}

/**
 * What a lane shows for a Task while an earlier try of it is picked: the try's number and its own
 * last report in place of the latest one's. Null while no try of this Task is picked, or the
 * picked one is the latest, so the lane shows the Task as it stands.
 */
export const pickedTry = (tree: TaskTree, task: Task, picked: AttemptId | undefined): PickedTry | null => {
  const attempts = triesOf(tree, task);
  const attempt = attempts.find((each) => each.id === picked);
  if (attempt === undefined || attempt === attempts[attempts.length - 1]) return null;
  const report = tree.checkpoints.findLast((each) => each.attemptId === attempt.id && saysMore(each));
  const result = task.result?.attemptId === attempt.id ? task.result.summary : undefined;
  return { number: attempt.number, line: result ?? report?.summary ?? attempt.outcome };
};

/** A question that climbed every lead to you from one of the lane's Tasks, with the Task it is on. */
export interface LaneQuestion {
  readonly task: Task;
  readonly question: Question;
}

/** The questions waiting for you on a hob's Tasks on the Quest, in the order of its Tasks. */
export const laneQuestions = (tree: TaskTree, tasks: ReadonlyArray<Task>): ReadonlyArray<LaneQuestion> =>
  tasks.flatMap((task) => {
    const question = questionForYou(tree, task);
    return question === null ? [] : [{ task, question }];
  });

/** A failed Task in a lane: why it stopped, as the hub recorded it, and what you can do about it. */
export interface LaneFailure {
  readonly task: Task;
  /** The last failure or blocker its hob reported, else why its last Attempt ended; null when neither was recorded. */
  readonly reason: string | null;
  readonly retry: boolean;
  readonly reassign: boolean;
}

/** Why a failed Task stopped, from what its hob reported, else from how its last Attempt ended. */
export const failureReason = (tree: TaskTree, task: Task): string | null => {
  // The hub's own checkpoint for the move only names the state, so it says nothing about why.
  const reported = tree.checkpoints.findLast(
    (each) =>
      each.taskId === task.id && each.source !== "automatic" && (each.kind === "failed" || each.kind === "blocker"),
  );
  if (reported !== undefined) return reported.summary;
  return triesOf(tree, task).at(-1)?.outcome ?? null;
};

/** The lane's Tasks that failed, each with why and with Retry and Reassign where the hub would accept them. */
export const laneFailures = (tree: TaskTree, tasks: ReadonlyArray<Task>): ReadonlyArray<LaneFailure> =>
  tasks.flatMap((task) => {
    if (task.state !== "failed") return [];
    const controls = taskControls(tree, task);
    return [{ task, reason: failureReason(tree, task), retry: controls.retry, reassign: controls.reassign }];
  });

/** The uncertain Charm writes made on a lane's Tasks (ADR 038), in the order the hub lists them. */
export const laneCharmCalls = (
  waiting: ReadonlyArray<WaitingCharmCall>,
  tasks: ReadonlyArray<Task>,
): ReadonlyArray<WaitingCharmCall> => {
  const ids = new Set(tasks.map((task) => task.id));
  return waiting.filter((each) => ids.has(each.task.id));
};
