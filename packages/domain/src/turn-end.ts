import type { LedgerEntry } from "./ledger.ts";
import {
  type AttemptEnd,
  type AttemptState,
  AttemptTransitions,
  isTerminalTask,
  type Task,
  type TaskState,
  type TaskTarget,
} from "./task.ts";

/**
 * The one turn-end decision (#669, #674): what an Attempt ends as and what its Task does once a turn
 * on it has ended, for every runner alike. The root's chat turns, a party member's turns and a
 * step's session each report how their turn ended, and the records and the Task follow from this.
 */

/** The runner a turn ran in: a step's session, a party member's session, or its hob's chat on the Task you asked for. */
export type TurnRunner = "step" | "member" | "root";

/** How a turn ended, as its runner saw it. */
export type TurnEnding =
  /** Its session ran to its end with this final reply, redacted and cut as its result would be. */
  | { readonly _tag: "Replied"; readonly text: string }
  | { readonly _tag: "Failed"; readonly reason: string | null }
  /** Hobbots stopped it: a cancel, a narrowed policy, its hob, or Stop on a reply. */
  | { readonly _tag: "Stopped"; readonly reason: string | null };

/** What the Task does once its turn has ended. */
export type TaskMove =
  | { readonly _tag: "Stay" }
  /** The final reply becomes its result; when the records refuse it, the Task does `otherwise`. */
  | { readonly _tag: "Complete"; readonly summary: string; readonly otherwise: TaskMove }
  | { readonly _tag: "Move"; readonly to: TaskTarget };

export interface TurnEnd {
  /** What the runner reports to the record, which ends the Attempt by `AttemptTransitions.end`. */
  readonly cause: AttemptEnd;
  /** The state the Attempt ends in, and why, for the Task as it was read. */
  readonly attempt: { readonly state: AttemptState; readonly outcome: string | null };
  readonly task: TaskMove;
  /** Why the Task is blocked, for the blocker its lead reads (#571); null when it is not. */
  readonly reason: string | null;
}

export interface TurnEndInput {
  readonly runner: TurnRunner;
  /** The Task as it is now the turn has ended. */
  readonly task: Task;
  readonly ending: TurnEnding;
  /** What keeps the Task open now, or empty when it was not read. */
  readonly ledger: ReadonlyArray<LedgerEntry>;
  /** The backpack items the turn carried, which settle with it and so keep nothing open. */
  readonly carried: ReadonlySet<string>;
  /** The root's state before the turn, which a turn that recorded no wait gives back. */
  readonly was?: TaskState;
}

/** What each runner's Attempt says when its session ran to its end. */
const FINISHED: Record<TurnRunner, string | null> = {
  step: "The step's session finished.",
  member: "The turn finished.",
  root: null,
};

/** What a Task's result says when the reply that becomes it was empty. */
const NO_REPLY: Record<Exclude<TurnRunner, "root">, string> = {
  step: "The step finished without a reply.",
  member: "The Task finished without a reply.",
};

/**
 * Why a member's Task is blocked when its turn ended with only its own `milestones` unreported, in
 * words its lead can act on: nothing it waits on is open, so it goes on only when someone acts, and
 * delegating the same work again leaves this Task behind (#571).
 */
export const stoppedShort = (milestones: ReadonlyArray<string>): string =>
  [
    `Its member ended a turn without completing it, and only its own milestones are unreported: ${milestones.map((title) => `"${title}"`).join(", ")}.`,
    "It waits on no question, approval or other Task, so nothing moves it on by itself.",
    "Hand it what it needs, or cancel or reassign it; delegating the same work again leaves this Task open.",
  ].join(" ");

const STAY: TaskMove = { _tag: "Stay" };
const move = (to: TaskTarget): TaskMove => ({ _tag: "Move", to });

/**
 * A member's Task its turn did not finish: it waits while anything it waits on is open, and is
 * blocked when only its own milestones are left, with a reason its lead can act on (#571).
 */
const heldOpen = (task: Task, open: ReadonlyArray<LedgerEntry>): Pick<TurnEnd, "task" | "reason"> => {
  if (task.state !== "active" && task.state !== "waiting") return { task: STAY, reason: null };
  const milestones = open.flatMap((entry) => (entry._tag === "Milestone" ? [entry.milestone.title] : []));
  if (open.length > 0 && milestones.length === open.length)
    return { task: move("blocked"), reason: stoppedShort(milestones) };
  return { task: task.state === "active" ? move("waiting") : STAY, reason: null };
};

/** What the Task does after the turn, by its runner. */
const taskAfter = (input: TurnEndInput): Pick<TurnEnd, "task" | "reason"> => {
  const { runner, task, ending } = input;
  if (isTerminalTask(task.state)) return { task: STAY, reason: null };
  // A cancel asked for is confirmed once the turn has ended; the records refuse it while work under it is open.
  if (task.state === "cancelling") return { task: move("cancelled"), reason: null };
  const open = input.ledger.filter((entry) => entry._tag !== "Item" || !input.carried.has(entry.item.id));
  switch (runner) {
    case "step":
      // A step that ended without its result fails; one that replied completes with the reply.
      return ending._tag === "Replied"
        ? {
            task: { _tag: "Complete", summary: ending.text.trim() || NO_REPLY.step, otherwise: move("failed") },
            reason: null,
          }
        : { task: move("failed"), reason: null };
    case "member": {
      // A failed turn leaves its work to be delivered again; a stopped one waits for it.
      if (ending._tag === "Failed") return { task: STAY, reason: null };
      if (ending._tag === "Stopped") return { task: task.state === "active" ? move("waiting") : STAY, reason: null };
      const held = heldOpen(task, open);
      if (open.length > 0) return held;
      return {
        task: { _tag: "Complete", summary: ending.text.trim() || NO_REPLY.member, otherwise: held.task },
        reason: held.reason,
      };
    }
    case "root": {
      // The Task you asked for completes only by complete_task. A wait that still holds shows
      // waiting (#572); otherwise one that waited, or was blocked, before the turn goes back to that.
      if (task.state !== "active") return { task: STAY, reason: null };
      if (open.some((entry) => entry._tag === "Wait")) return { task: move("waiting"), reason: null };
      return { task: input.was === "waiting" || input.was === "blocked" ? move(input.was) : STAY, reason: null };
    }
  }
};

/** Why the Attempt of a turn that ended so ended, as its runner reports it to the record. */
export const attemptEndOf = (runner: TurnRunner, ending: TurnEnding): AttemptEnd =>
  ending._tag === "Replied"
    ? { _tag: "Finished", outcome: FINISHED[runner] }
    : ending._tag === "Failed"
      ? { _tag: "Failed", reason: ending.reason }
      : { _tag: "Stopped", reason: ending.reason };

/** The turn-end decision: the Attempt's end, what the Task does, and why. */
export const turnEnded = (input: TurnEndInput): TurnEnd => {
  const cause = attemptEndOf(input.runner, input.ending);
  return { cause, attempt: AttemptTransitions.end(input.task, cause), ...taskAfter(input) };
};
