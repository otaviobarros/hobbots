import { Schema } from "effect";
import { ConfigVersion, RuntimeKind } from "./agent.ts";
import { AgentId, ThreadId } from "./ids.ts";
import { Revision } from "./revision.ts";

/**
 * Tasks of ADR 018: one hob's piece of work, end to end. Steps, a party member's work and nested
 * Quests are all Tasks in one tree, each with its owner, parent and root. A retry is a new Attempt
 * of the same Task, never a new Task (EX-001).
 */

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;

export const AttemptId = Schema.String.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptId.Type;

/**
 * Where a Task stands (execution lifecycle). `waiting` is on a dependency, approval or answer;
 * `blocked` needs something its owner cannot do; `cancelling` is a cancel requested and not yet
 * confirmed. `completed`, `failed` and `cancelled` are terminal; only a retry reopens a failed Task.
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

/** An Attempt is live while `starting` or `running`; the other states are its outcome. */
export const AttemptState = Schema.Literals(["starting", "running", "completed", "failed", "interrupted", "cancelled"]);
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

const ALLOWED: Record<TaskTarget, ReadonlyArray<TaskState>> = {
  waiting: ["active"],
  blocked: ["active", "waiting"],
  active: ["waiting", "blocked"],
  failed: ["queued", "active", "waiting", "blocked"],
  cancelling: ["queued", "active", "waiting", "blocked"],
  // A queued Task has nothing running, so its cancel is confirmed at once.
  cancelled: ["queued", "cancelling"],
};

/** Pure transitions for a Task (EX-002). Each returns the next Task or why it cannot. */
export const TaskTransitions = {
  moveTo: (task: Task, to: TaskTarget, at: string): Task | IllegalTaskTransition =>
    ALLOWED[to].includes(task.state)
      ? new Task({ ...task, state: to, updatedAt: at })
      : new IllegalTaskTransition({ taskId: task.id, from: task.state, to }),

  /** A new Attempt makes the Task active: a first start, a resume, or a retry of a failed Task. */
  start: (task: Task, attemptId: AttemptId, at: string): Task | IllegalTaskTransition =>
    task.state === "completed" || task.state === "cancelled" || task.state === "cancelling"
      ? new IllegalTaskTransition({ taskId: task.id, from: task.state, to: "active" })
      : new Task({ ...task, state: "active", currentAttemptId: attemptId, updatedAt: at }),

  complete: (task: Task, result: TaskResult, at: string): Task | IllegalTaskTransition =>
    task.state === "active" || task.state === "waiting"
      ? new Task({ ...task, state: "completed", result, updatedAt: at })
      : new IllegalTaskTransition({ taskId: task.id, from: task.state, to: "completed" }),
};

/** Every Task under `task` among `tree`, the Tasks of its tree, in their order in `tree`. */
export const descendantsOf = (task: Task, tree: ReadonlyArray<Task>): ReadonlyArray<Task> => {
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
