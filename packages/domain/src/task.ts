import { Schema } from "effect";
import { ConfigVersion, RuntimeKind } from "./agent.ts";
import { AgentId, TaskId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import type { TaskReadiness } from "./readiness.ts";
import { Revision } from "./revision.ts";
import { WebReadMark } from "./web-mark.ts";

// The Task id lives with the other ids, so a hob can name the Task it was summoned for without a cycle.
export { TaskId } from "./ids.ts";

/**
 * Tasks of ADR 018: one hob's piece of work, end to end. Steps, a party member's work and nested
 * Quests are all Tasks in one tree, each with its owner, parent and root. A retry is a new Attempt
 * of the same Task, never a new Task (EX-001).
 */

export const AttemptId = Schema.String.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptId.Type;

/**
 * Where a Task stands (execution lifecycle). `waiting` is on a dependency, approval or answer;
 * `blocked` waits for a decision from outside its turn: its lead's, or for a step its owner's;
 * `cancelling` is a cancel requested and not yet confirmed. `completed`, `failed` and `cancelled` are terminal; only a retry reopens a failed Task.
 */
export const TaskState = Schema.Literals([
  "queued",
  "active",
  "waiting",
  "blocked",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskState = typeof TaskState.Type;

export const isTerminalTask = (state: TaskState): boolean =>
  state === "completed" || state === "failed" || state === "cancelled";

/** Whether a Task ended with its result. */
export const isCompletedTask = (state: TaskState): boolean => state === "completed";

/** The result a Task returned: a short summary and the Attempt that produced it. */
export const TaskResult = Schema.Struct({
  summary: Schema.String,
  attemptId: AttemptId,
});
export type TaskResult = typeof TaskResult.Type;

export class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  /** The hob that owns the work. A step has its parent's owner; another owner comes with a Delegation. */
  ownerId: AgentId,
  /** The Task it is part of, or null for the Task you asked for. */
  parentId: Schema.NullOr(TaskId),
  /** The top Task of its tree: itself for the Task you asked for. Grants for This Task bind to it. */
  rootId: TaskId,
  /** The thread whose request started the tree, shared by every Task in it. */
  threadId: Schema.NullOr(ThreadId),
  brief: Schema.String,
  state: TaskState,
  /** Tasks in the same tree that must complete before this one can. */
  dependsOn: Schema.Array(TaskId),
  /** Set when the Task completes. */
  result: Schema.NullOr(TaskResult),
  /** The Attempt running or last run, or null before the first. */
  currentAttemptId: Schema.NullOr(AttemptId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** The Task's version: changes that name a stale one are refused (EX-002). */
  revision: Revision,
}) {}

/**
 * A party member's failed Task that waits on you (ADR 027): its top Task is still under way, so you
 * can retry or reassign it. `leadId` is the hob whose chat the work was asked in, which you talk to
 * about it, or null for work with no thread.
 */
export const FailedTask = Schema.Struct({ task: Task, leadId: Schema.NullOr(AgentId) });
export type FailedTask = typeof FailedTask.Type;

/**
 * An Attempt is live while `starting` or `running`; the other states are its outcome. `unresolved`
 * is a cancel Hobbots asked for and could not confirm in time: whether its session stopped is not
 * known (OR-006).
 */
export const AttemptState = Schema.Literals([
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "unresolved",
]);
export type AttemptState = typeof AttemptState.Type;

export const isLiveAttempt = (state: AttemptState): boolean => state === "starting" || state === "running";

/** One attempt to do a Task's work, called Execution in the agent model. */
export class Attempt extends Schema.Class<Attempt>("Attempt")({
  id: AttemptId,
  taskId: TaskId,
  /** 1 for the first attempt, then one more for each retry. */
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The hob that ran it, so history keeps who worked on it. */
  agentId: AgentId,
  runtime: RuntimeKind,
  /** The runtime's session, once it has one. */
  sessionId: Schema.NullOr(Schema.String),
  configVersion: ConfigVersion,
  /** The policy the attempt started under, when known. */
  policyVersion: Schema.NullOr(Schema.String),
  state: AttemptState,
  /** Why it ended, in a sentence, once it has. */
  outcome: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  /**
   * The read-the-web mark of the session it ran in (ADR 036), once that session searched or read a
   * page, which the Workbench shows. Absent or null while it read nothing.
   */
  readWeb: Schema.optionalKey(Schema.NullOr(WebReadMark)),
}) {}

/** A change of state the Task's current state does not allow. */
export class IllegalTaskTransition extends Schema.TaggedError<IllegalTaskTransition>()("IllegalTaskTransition", {
  taskId: TaskId,
  from: TaskState,
  to: TaskState,
}) {}

/** A change that names a version of the Task other than the stored one (EX-002). */
export class StaleTask extends Schema.TaggedError<StaleTask>()("StaleTask", {
  taskId: TaskId,
  expected: Schema.Int,
  actual: Schema.Int,
}) {}

/** The states a Task can be moved to directly; starting an Attempt and completing have their own rules. */
export const TaskTarget = Schema.Literals(["waiting", "blocked", "active", "failed", "cancelling", "cancelled"]);
export type TaskTarget = typeof TaskTarget.Type;

/** What can happen to a Task. Each event names the time it happened. */
export type TaskEvent =
  | { readonly _tag: "Wait"; readonly at: string }
  | { readonly _tag: "Block"; readonly at: string }
  | { readonly _tag: "Resume"; readonly at: string }
  | { readonly _tag: "Fail"; readonly at: string }
  | { readonly _tag: "RequestCancel"; readonly at: string }
  | { readonly _tag: "Cancel"; readonly at: string }
  | {
      readonly _tag: "Start";
      readonly at: string;
      readonly attemptId: AttemptId;
      readonly readiness: TaskReadiness;
    }
  | { readonly _tag: "Retry"; readonly at: string }
  | { readonly _tag: "Reassign"; readonly at: string; readonly ownerId: AgentId }
  | { readonly _tag: "Complete"; readonly at: string; readonly result: TaskResult };

/** The states a Task with nothing ended can be in: an Attempt may start, or another hob take it over. */
const OPEN: ReadonlyArray<TaskState> = ["queued", "active", "waiting", "blocked", "failed"];

const moved = (task: Task, to: TaskState, at: string) => new Task({ ...task, state: to, updatedAt: at });

/** A Task's lifecycle (EX-002, ADR 018), declared once (ADR 037). */
export const TaskMachine = defineMachine<TaskState, TaskEvent, Task, IllegalTaskTransition>({
  name: "Task",
  states: {
    queued: "Waiting for its first Attempt, or for the next one after a retry or reassignment",
    active: "An Attempt is running",
    waiting: "Waiting on a dependency, an approval or an answer",
    blocked: "Waiting for a decision from outside its turn: its lead's, or for a step its owner's",
    cancelling: "A cancel was requested and is not confirmed yet",
    completed: "Done, with its result",
    failed: "Ended without a result; a retry or reassignment reopens it",
    cancelled: "Stopped, and the stop is confirmed",
  },
  field: "state",
  events: {
    Wait: { from: ["active"], to: "waiting", apply: (task, e) => moved(task, "waiting", e.at) },
    Block: { from: ["active", "waiting"], to: "blocked", apply: (task, e) => moved(task, "blocked", e.at) },
    Resume: { from: ["waiting", "blocked"], to: "active", apply: (task, e) => moved(task, "active", e.at) },
    Fail: {
      from: ["queued", "active", "waiting", "blocked"],
      to: "failed",
      apply: (task, e) => moved(task, "failed", e.at),
    },
    RequestCancel: {
      from: ["queued", "active", "waiting", "blocked"],
      to: "cancelling",
      apply: (task, e) => moved(task, "cancelling", e.at),
    },
    // A queued Task has nothing running, so its cancel is confirmed at once.
    Cancel: { from: ["queued", "cancelling"], to: "cancelled", apply: (task, e) => moved(task, "cancelled", e.at) },
    // A first start, a resume, or a retry of a failed Task, once its tree says it is Ready.
    Start: {
      from: OPEN,
      to: "active",
      guard: (_, e) => e.readiness._tag === "Ready",
      apply: (task, e) => new Task({ ...task, state: "active", currentAttemptId: e.attemptId, updatedAt: e.at }),
    },
    // A retry puts a failed Task back in the queue, for a new Attempt of the same Task (EX-001).
    Retry: { from: ["failed"], to: "queued", apply: (task, e) => moved(task, "queued", e.at) },
    // Another hob takes the Task, queued for its first Attempt there; nothing of the earlier owner's carries over.
    Reassign: {
      from: OPEN,
      to: "queued",
      apply: (task, e) =>
        new Task({ ...task, ownerId: e.ownerId, state: "queued", currentAttemptId: null, updatedAt: e.at }),
    },
    // From its turn, or, once blocked, as its owner decides how it ends (#667).
    Complete: {
      from: ["active", "waiting", "blocked"],
      to: "completed",
      apply: (task, e) => new Task({ ...task, state: "completed", result: e.result, updatedAt: e.at }),
    },
  },
  illegal: (task, _, to) => new IllegalTaskTransition({ taskId: task.id, from: task.state, to }),
});

/** The event that moves a Task straight to each target. */
const TO_TARGET = {
  waiting: "Wait",
  blocked: "Block",
  active: "Resume",
  failed: "Fail",
  cancelling: "RequestCancel",
  cancelled: "Cancel",
} as const satisfies Record<TaskTarget, TaskEvent["_tag"]>;

/** Pure transitions for a Task (EX-002), as calls on `TaskMachine`. Each returns the next Task or why it cannot. */
export const TaskTransitions = {
  moveTo: (task: Task, to: TaskTarget, at: string): Task | IllegalTaskTransition =>
    TaskMachine.transition(task, { _tag: TO_TARGET[to], at }),

  /**
   * A new Attempt makes the Task active: a first start, a resume, or a retry of a failed Task. It
   * starts only when `readiness`, read from its tree, is Ready.
   */
  start: (task: Task, attemptId: AttemptId, at: string, readiness: TaskReadiness): Task | IllegalTaskTransition =>
    TaskMachine.transition(task, { _tag: "Start", at, attemptId, readiness }),

  /** A retry puts a failed Task back in the queue, for a new Attempt of the same Task (EX-001). */
  retry: (task: Task, at: string): Task | IllegalTaskTransition => TaskMachine.transition(task, { _tag: "Retry", at }),

  /**
   * A reassignment gives a Task that failed, or that is open with nothing running, to another hob,
   * queued for its first Attempt there. The Task keeps its id and its history; no Attempt is its
   * current one until the new owner starts, so nothing of the earlier owner's carries over.
   */
  reassign: (task: Task, ownerId: AgentId, at: string): Task | IllegalTaskTransition =>
    TaskMachine.transition(task, { _tag: "Reassign", at, ownerId }),

  /**
   * A Task completes from its turn, or, once blocked, when its owner decides how it ends: a step
   * that stopped on a finding completes with the result its owner gives (#667).
   */
  complete: (task: Task, result: TaskResult, at: string): Task | IllegalTaskTransition =>
    TaskMachine.transition(task, { _tag: "Complete", at, result }),
};

/**
 * Why an Attempt ended, as the runner that ran it saw it: its session ran to its end, failed,
 * was stopped by Hobbots, or did not confirm a stop in time. The record decides the state it ends
 * in from this and its Task, so every runner ends Attempts the same way (#669, #674).
 */
export type AttemptEnd =
  | { readonly _tag: "Finished"; readonly outcome: string | null }
  | { readonly _tag: "Failed"; readonly reason: string | null }
  | { readonly _tag: "Stopped"; readonly reason: string | null }
  | { readonly _tag: "Unconfirmed"; readonly reason: string };

/** What an Attempt that ended because its Task was cancelled says, when who cancelled it is not known. */
export const CANCELLED_ATTEMPT = "Its Task was cancelled before this turn ended.";

/** What an Attempt says that ended because `by` cancelled its Task: a hob's name, "You", or null when not known. */
export const cancelledOutcome = (by: string | null): string =>
  by === null ? CANCELLED_ATTEMPT : `${by} cancelled this Task.`;

/** Pure transitions for an Attempt, beside the Task's. */
export const AttemptTransitions = {
  /**
   * The state an Attempt ends in, and why, for `end`, with its Task as it is when it ends. An
   * Attempt whose Task's cancel was asked for ends cancelled, naming who cancelled it (`cancelledBy`),
   * whether it finished or was stopped; one that failed on its own stays failed, and one whose stop
   * could not be confirmed stays unresolved. One that ended before the cancel keeps its own end.
   */
  end: (
    task: Task,
    end: AttemptEnd,
    cancelledBy: string | null = null,
  ): { readonly state: AttemptState; readonly outcome: string | null } => {
    switch (end._tag) {
      case "Failed":
        return { state: "failed", outcome: end.reason };
      case "Unconfirmed":
        return { state: "unresolved", outcome: end.reason };
      default:
        if (task.state === "cancelling" || task.state === "cancelled")
          return { state: "cancelled", outcome: cancelledOutcome(cancelledBy) };
        return end._tag === "Finished"
          ? { state: "completed", outcome: end.outcome }
          : { state: "interrupted", outcome: end.reason };
    }
  },
};

/** Every Task under `task` among `tree`, the Tasks of its tree, in their order in `tree`. */
export const descendantsOf = <T extends Pick<Task, "id" | "parentId">>(
  task: T,
  tree: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const children = new Map<TaskId, Array<TaskId>>();
  for (const each of tree) {
    if (each.parentId !== null) children.set(each.parentId, [...(children.get(each.parentId) ?? []), each.id]);
  }
  const under = new Set<TaskId>();
  for (let next = children.get(task.id) ?? []; next.length > 0; ) {
    for (const id of next) under.add(id);
    next = next.flatMap((id) => children.get(id) ?? []).filter((id) => !under.has(id));
  }
  return tree.filter((each) => under.has(each.id));
};

/** The Tasks above `task` among `tree`, its parent first and its root last. */
export const ancestorsOf = (task: Task, tree: ReadonlyArray<Task>): ReadonlyArray<Task> => {
  const byId = new Map(tree.map((each) => [each.id, each]));
  const above: Array<Task> = [];
  for (let at = task.parentId === null ? undefined : byId.get(task.parentId); at !== undefined; ) {
    if (above.includes(at)) break;
    above.push(at);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return above;
};

/**
 * The leads above a Task, nearest first: the owners of its ancestors other than its own owner.
 * A question climbs this list, and reaches the user past its end; a member's reports go to the first.
 */
export const leadsAbove = (task: Task, tree: ReadonlyArray<Task>): ReadonlyArray<AgentId> => [
  ...new Set(ancestorsOf(task, tree).flatMap((each) => (each.ownerId === task.ownerId ? [] : [each.ownerId]))),
];

/**
 * The hob a note you leave on a Task goes to (ADR 018): the nearest lead whose own Task is still
 * open, so a lead that finished never holds it unread, or the Task's owner when nobody leads it.
 */
export const noteRecipientOf = (task: Task, tree: ReadonlyArray<Task>): AgentId =>
  ancestorsOf(task, tree).find((each) => each.ownerId !== task.ownerId && !isTerminalTask(each.state))?.ownerId ??
  task.ownerId;
