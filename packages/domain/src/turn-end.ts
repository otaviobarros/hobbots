import type { LedgerEntry } from "./ledger.ts";
import type { CheckpointKind } from "./quest.ts";
import {
  type AttemptEnd,
  type AttemptState,
  AttemptTransitions,
  isTerminalTask,
  type PausedFrom,
  type Task,
  TaskPauses,
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
  /**
   * A member's turn ended in prose with nothing open and without `complete_task`: its session goes
   * on once in the same Attempt, told to call `complete_task` or report a blocker, since a reply
   * alone cannot tell "done" from "I am stuck" (#1086).
   */
  | { readonly _tag: "SendBack" }
  /**
   * The final reply becomes its result; when the records refuse it, the Task does `otherwise`, and
   * with `explainRefusal` the refusal is recorded as why.
   */
  | {
      readonly _tag: "Complete";
      readonly summary: string;
      readonly otherwise: TaskMove;
      readonly explainRefusal: boolean;
    }
  /**
   * With a `reason` when it moves to blocked or failed, which its lead reads with the move (#571):
   * the move records it as a blocker in the same change, so the lead hears of it once (#683).
   */
  | { readonly _tag: "Move"; readonly to: TaskTarget; readonly reason?: string }
  /**
   * The Task was paused while its turn ran (#1446): it is paused now, and goes back to `otherwise`
   * on Resume unless the turn moved it on itself.
   */
  | { readonly _tag: "SettlePause"; readonly otherwise: PausedFrom };

export interface TurnEnd {
  /** What the runner reports to the record, which ends the Attempt by `AttemptTransitions.end`. */
  readonly cause: AttemptEnd;
  /** The state the Attempt ends in, and why, for the Task as it was read. */
  readonly attempt: { readonly state: AttemptState; readonly outcome: string | null };
  readonly task: TaskMove;
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
  /**
   * What the turn last reported in its Attempt, other than progress: a step that stopped on a finding
   * or blocker is held (#667), and a member that reported a blocker is blocked on it (#1086).
   */
  readonly lastReport?: CheckpointKind;
  /** A member's turn that ran because its last one was sent back to finish properly (#1086). */
  readonly sentBack?: boolean;
}

/** What each runner's Attempt says when its session ran to its end. */
const FINISHED: Record<TurnRunner, string> = {
  step: "The step's session finished.",
  member: "The turn finished.",
  root: "The turn finished.",
};

/** What a step's result says when the reply that becomes it was empty. */
const NO_STEP_REPLY = "The step finished without a reply.";

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

/**
 * Why a member's Task is blocked when it was sent back to finish and its turn again ended without
 * `complete_task` or a blocker (#1086): its reply, which its lead reads to decide what comes next.
 */
export const endedUnfinished = (reply: string): string =>
  [
    "Its member ended its turn without completing it, twice, and reported no blocker.",
    "It was not marked done, since its reply does not say whether the work is finished.",
    reply === "" ? "Its member gave no reply." : `Its member's last reply: ${reply}`,
  ].join(" ");

const STAY: TaskMove = { _tag: "Stay" };
const SEND_BACK: TaskMove = { _tag: "SendBack" };
const move = (to: TaskTarget, reason?: string): TaskMove =>
  reason === undefined ? { _tag: "Move", to } : { _tag: "Move", to, reason };

/**
 * A member's Task its turn did not finish: it waits while anything it waits on is open, and is
 * blocked when only its own milestones are left, with a reason its lead can act on (#571).
 */
const heldOpen = (task: Task, open: ReadonlyArray<LedgerEntry>): TaskMove => {
  if (task.state !== "active" && task.state !== "waiting") return STAY;
  const milestones = open.flatMap((entry) => (entry._tag === "Milestone" ? [entry.milestone.title] : []));
  if (open.length > 0 && milestones.length === open.length) return move("blocked", stoppedShort(milestones));
  return task.state === "active" ? move("waiting") : STAY;
};

/**
 * A member's Task after its turn: a failed turn leaves its work to be delivered again; a stopped one
 * waits for it. A Task completes only by `complete_task` (#1086): a reply with nothing open sends its
 * member back once to call it or report a blocker, and a second such reply blocks the Task with the
 * reply as why, so its lead reads what the member said rather than a Task shown done. One that
 * reported a blocker is blocked on it, which its lead already heard, and is not sent back.
 */
const memberAfter = (
  task: Task,
  ending: TurnEnding,
  open: ReadonlyArray<LedgerEntry>,
  { sentBack, lastReport }: { readonly sentBack: boolean; readonly lastReport: CheckpointKind | undefined },
): TaskMove => {
  if (ending._tag === "Failed") return STAY;
  if (ending._tag === "Stopped") return task.state === "active" ? move("waiting") : STAY;
  if (open.length > 0) return heldOpen(task, open);
  if (lastReport === "blocker") return task.state === "blocked" ? STAY : move("blocked");
  if (!sentBack) return SEND_BACK;
  return task.state === "blocked" ? STAY : move("blocked", endedUnfinished(ending.text.trim()));
};

/**
 * The Task you asked for after its turn: it completes only by complete_task. A wait that still holds
 * shows waiting (#572); otherwise one that waited, or was blocked, before the turn goes back to that.
 * One blocked because its Quest had nothing moving it is not blocked once a Task under it is open (#1081).
 */
const rootAfter = (task: Task, open: ReadonlyArray<LedgerEntry>, was: TaskState | undefined): TaskMove => {
  if (task.state !== "active") return STAY;
  if (open.some((entry) => entry._tag === "Wait")) return move("waiting");
  if (was === "blocked" && open.some((entry) => entry._tag === "Child")) return STAY;
  return was === "waiting" || was === "blocked" ? move(was) : STAY;
};

/** Where each runner's Task goes back to on Resume once its turn was cut short by a pause (#1446). */
const RESUMED_AS: Record<TurnRunner, PausedFrom> = { step: "queued", member: "waiting", root: "active" };

/**
 * A Task you paused while its turn ran (#1446): a step that finished still completes with its reply;
 * any other is paused now, for Resume to take on from where it stood.
 */
const pausedAfter = (input: TurnEndInput): TaskMove => {
  const settle: TaskMove = { _tag: "SettlePause", otherwise: RESUMED_AS[input.runner] };
  const { ending } = input;
  if (input.runner !== "step" || ending._tag !== "Replied") return settle;
  if (input.lastReport === "finding" || input.lastReport === "blocker") return settle;
  return { _tag: "Complete", summary: ending.text.trim() || NO_STEP_REPLY, otherwise: settle, explainRefusal: false };
};

/** What the Task does after the turn, by its runner. */
const taskAfter = (input: TurnEndInput): TaskMove => {
  const { runner, task, ending } = input;
  if (TaskPauses.isPausing(task)) return pausedAfter(input);
  if (isTerminalTask(task.state) || TaskPauses.isPaused(task)) return STAY;
  // A cancel asked for is confirmed once the turn has ended; the records refuse it while work under it is open.
  if (task.state === "cancelling") return move("cancelled");
  const open = input.ledger.filter((entry) => entry._tag !== "Item" || !input.carried.has(entry.item.id));
  switch (runner) {
    case "step":
      // A step that ended without its result fails; one that replied completes with the reply. One
      // that replied after reporting a finding or blocker stopped for its owner to decide: it is
      // blocked, so the steps after it wait (#667).
      if (ending._tag === "Replied" && (input.lastReport === "finding" || input.lastReport === "blocker"))
        return move("blocked");
      return ending._tag === "Replied"
        ? {
            _tag: "Complete",
            summary: ending.text.trim() || NO_STEP_REPLY,
            otherwise: move("failed"),
            explainRefusal: true,
          }
        : move("failed");
    case "member":
      return memberAfter(task, ending, open, { sentBack: input.sentBack === true, lastReport: input.lastReport });
    case "root":
      return rootAfter(task, open, input.was);
  }
};

/** Why the Attempt of a turn that ended so ended, as its runner reports it to the record. */
export const attemptEndOf = (runner: TurnRunner, ending: TurnEnding): AttemptEnd =>
  ending._tag === "Replied"
    ? { _tag: "Finished", outcome: FINISHED[runner] }
    : ending._tag === "Failed"
      ? { _tag: "Failed", reason: ending.reason }
      : { _tag: "Stopped", reason: ending.reason };

/** The turn-end decision: the Attempt's end, and what the Task does. */
export const turnEnded = (input: TurnEndInput): TurnEnd => {
  const cause = attemptEndOf(input.runner, input.ending);
  return { cause, attempt: AttemptTransitions.end(input.task, cause), task: taskAfter(input) };
};
