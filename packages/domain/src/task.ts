import { Effect, Schema } from "effect";
import { Actor } from "./actor.ts";
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
 * Where a Task stands (attempt lifecycle). `waiting` is on a dependency, approval or answer;
 * `blocked` waits for a decision from outside its turn: its lead's, or for a step its owner's;
 * `pausing` is a pause you asked for while its turn still runs, and `paused` starts no turn until
 * you resume it (#1446); `cancelling` is a cancel requested and not yet confirmed. `completed`,
 * `failed` and `cancelled` are terminal; only a retry reopens a failed Task.
 */
export const TaskState = Schema.Literals([
  "queued",
  "active",
  "waiting",
  "blocked",
  "pausing",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskState = typeof TaskState.Type;

export const isTerminalTask = (state: TaskState): boolean =>
  state === "completed" || state === "failed" || state === "cancelled";

/** Whether a cancel was asked for a Task and is not confirmed yet: no new work starts under it (OR-006). */
export const isCancellingTask = (state: TaskState): boolean => state === "cancelling";

/** Whether a Task ended with its result. */
export const isCompletedTask = (state: TaskState): boolean => state === "completed";

/** The result a Task returned: a short summary and the Attempt that produced it. */
export const TaskResult = Schema.Struct({
  summary: Schema.String,
  attemptId: AttemptId,
});
export type TaskResult = typeof TaskResult.Type;

/** The states a paused Task goes back to when you resume it: where it stood before the pause. */
export const PausedFrom = Schema.Literals(["queued", "active", "waiting", "blocked"]);
export type PausedFrom = typeof PausedFrom.Type;

/**
 * A pause you put on a Task (#1446): who paused it and when, whether its running turn was stopped
 * at once (`now`, Pause now) or left to end (Pause), and the state it goes back to on Resume.
 */
export const TaskPause = Schema.Struct({
  from: PausedFrom,
  at: Schema.String,
  by: Actor,
  now: Schema.Boolean,
});
export type TaskPause = typeof TaskPause.Type;

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
  /**
   * The pause on it while it is `pausing` or `paused` (#1446); null otherwise, and for Tasks
   * journaled before migration 20261114004439_pauses.
   */
  pause: Schema.NullOr(TaskPause).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
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
  | { readonly _tag: "Complete"; readonly at: string; readonly result: TaskResult }
  /**
   * You pause it (#1446). `running` says whether a turn runs on it now, read by the caller: a turn
   * that runs ends first, stopped at once when `now` (Pause now), or left to end (Pause).
   */
  | {
      readonly _tag: "Pause";
      readonly at: string;
      readonly by: Actor;
      readonly now: boolean;
      readonly running: boolean;
    }
  /**
   * The turn that ran as you paused it ended (#1446). A Task its turn left mid-work goes back to
   * `otherwise` on Resume: waiting for a member, whom Resume's note wakes, queued for a step, which
   * starts afresh, active for the Task you asked for.
   */
  | { readonly _tag: "PauseSettled"; readonly at: string; readonly otherwise: PausedFrom }
  /** You resume it (#1446): back to `to`, where its pause says it stood. */
  | { readonly _tag: "Unpause"; readonly at: string; readonly to: PausedFrom };

/** The states a Task with nothing ended can be in: an Attempt may start, or another hob take it over. */
const OPEN: ReadonlyArray<TaskState> = ["queued", "active", "waiting", "blocked", "failed"];

/** The states a turn may still run in: those it starts from, and a pause that waits for it to end. */
const UNDER_WAY: ReadonlyArray<TaskState> = ["queued", "active", "waiting", "blocked", "pausing"];

const moved = (task: Task, to: TaskState, at: string) => new Task({ ...task, state: to, updatedAt: at });

/** A pause asked for from `from`, by the event. */
const pausedAs = (task: Task, to: "pausing" | "paused", from: PausedFrom, e: Extract<TaskEvent, { _tag: "Pause" }>) =>
  new Task({ ...task, state: to, pause: { from, at: e.at, by: e.by, now: e.now }, updatedAt: e.at });

/** The pause's state to go back to, kept while its turn runs: what the turn did meanwhile moves it. */
const repaused = (task: Task, from: PausedFrom, at: string) =>
  new Task({ ...task, pause: task.pause === null ? null : { ...task.pause, from }, updatedAt: at });

/** Resume to `to`: one rule per state, so the table names each. */
const unpauseTo = (to: PausedFrom) => ({
  from: ["paused"] as ReadonlyArray<TaskState>,
  to,
  guard: (_: Task, e: Extract<TaskEvent, { _tag: "Unpause" }>) => e.to === to,
  apply: (task: Task, e: Extract<TaskEvent, { _tag: "Unpause" }>) =>
    new Task({ ...task, state: to, pause: null, updatedAt: e.at }),
});

/** A Task's lifecycle (EX-002, ADR 018), declared once (ADR 037). */
export const TaskMachine = defineMachine<TaskState, TaskEvent, Task, IllegalTaskTransition>({
  name: "Task",
  states: {
    queued: "Waiting for its first Attempt, or for the next one after a retry or reassignment",
    active: "An Attempt is running",
    waiting: "Waiting on a dependency, an approval or an answer",
    blocked: "Waiting for a decision from outside its turn: its lead's, or for a step its owner's",
    pausing: "You paused it while its turn ran; no turn starts once that one ends",
    paused: "You paused it; no turn starts on it until you resume it",
    cancelling: "A cancel was requested and is not confirmed yet",
    completed: "Done, with its result",
    failed: "Ended without a result; a retry or reassignment reopens it",
    cancelled: "Stopped, and the stop is confirmed",
  },
  field: "state",
  events: {
    // A turn running while you paused waits as it would, and goes back there on Resume.
    Wait: [
      { from: ["active"], to: "waiting", apply: (task, e) => moved(task, "waiting", e.at) },
      { from: ["pausing"], to: "pausing", apply: (task, e) => repaused(task, "waiting", e.at) },
    ],
    Block: [
      { from: ["active", "waiting"], to: "blocked", apply: (task, e) => moved(task, "blocked", e.at) },
      { from: ["pausing"], to: "pausing", apply: (task, e) => repaused(task, "blocked", e.at) },
    ],
    Resume: { from: ["waiting", "blocked"], to: "active", apply: (task, e) => moved(task, "active", e.at) },
    Fail: {
      from: [...UNDER_WAY, "paused"],
      to: "failed",
      apply: (task, e) => new Task({ ...task, state: "failed", pause: null, updatedAt: e.at }),
    },
    RequestCancel: {
      from: [...UNDER_WAY, "paused"],
      to: "cancelling",
      apply: (task, e) => new Task({ ...task, state: "cancelling", pause: null, updatedAt: e.at }),
    },
    // A queued or paused Task has nothing running, so its cancel is confirmed at once.
    Cancel: {
      from: ["queued", "paused", "cancelling"],
      to: "cancelled",
      apply: (task, e) => new Task({ ...task, state: "cancelled", pause: null, updatedAt: e.at }),
    },
    // A first start, a resume, or a retry of a failed Task, once its tree says it is Ready. Never while paused.
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
    // From its turn, or, once blocked, as its owner decides how it ends (#667); a turn that runs
    // on as you pause it still delivers what it finished.
    Complete: {
      from: ["active", "waiting", "blocked", "pausing"],
      to: "completed",
      apply: (task, e) => new Task({ ...task, state: "completed", result: e.result, pause: null, updatedAt: e.at }),
    },
    // A Task with a turn running waits for it to end; any other stops at once.
    Pause: [
      {
        from: ["active"],
        to: "pausing",
        guard: (_, e) => e.running,
        apply: (task, e) => pausedAs(task, "pausing", "active", e),
      },
      {
        from: ["queued", "active", "waiting", "blocked"],
        to: "paused",
        apply: (task, e) => pausedAs(task, "paused", task.state as PausedFrom, e),
      },
    ],
    // What the ended turn left: where it stood if it moved there itself, else `otherwise`.
    PauseSettled: {
      from: ["pausing"],
      to: "paused",
      apply: (task, e) => {
        const from = task.pause === null || task.pause.from === "active" ? e.otherwise : task.pause.from;
        return new Task({
          ...task,
          state: "paused",
          pause: task.pause === null ? null : { ...task.pause, from },
          updatedAt: e.at,
        });
      },
    },
    Unpause: [
      unpauseTo("queued"),
      unpauseTo("active"),
      unpauseTo("waiting"),
      unpauseTo("blocked"),
      // Resumed before its turn ended: it simply goes on.
      {
        from: ["pausing"],
        to: "active",
        apply: (task, e) => new Task({ ...task, state: "active", pause: null, updatedAt: e.at }),
      },
    ],
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

  /** Pauses the Task for `by` (#1446): pausing while a turn runs on it, paused otherwise. */
  pause: (
    task: Task,
    pause: { readonly at: string; readonly by: Actor; readonly now: boolean; readonly running: boolean },
  ): Task | IllegalTaskTransition => TaskMachine.transition(task, { _tag: "Pause", ...pause }),

  /** The turn a pause waited for ended: the Task is paused, back to `otherwise` on Resume unless it moved. */
  settlePause: (task: Task, otherwise: PausedFrom, at: string): Task | IllegalTaskTransition =>
    TaskMachine.transition(task, { _tag: "PauseSettled", at, otherwise }),

  /** Resumes a paused Task where its pause says it stood, or a pausing one whose turn still runs. */
  unpause: (task: Task, at: string): Task | IllegalTaskTransition =>
    TaskMachine.transition(task, { _tag: "Unpause", at, to: task.pause?.from ?? "active" }),
};

/** The questions code outside this module asks of a Task's pause (#1446). */
export const TaskPauses = {
  /** Whether you paused it: its turn may still be ending, but none starts. */
  isPaused: (task: Pick<Task, "state">): boolean => task.state === "pausing" || task.state === "paused",
  /** Whether a turn it waited for still runs on it. */
  isPausing: (task: Pick<Task, "state">): boolean => task.state === "pausing",
  /** Whether it can be paused now: it is under way and not paused already. */
  canPause: (task: Pick<Task, "state">): boolean =>
    task.state === "queued" || task.state === "active" || task.state === "waiting" || task.state === "blocked",
};

/**
 * The paused Task that holds `task` (#1446): itself, or the nearest Task above it that you paused.
 * No turn starts on a held Task, and no work lands on it. Undefined when nothing holds it.
 */
export const pausedHolder = <T extends Pick<Task, "id" | "parentId" | "state">>(
  task: T,
  tree: ReadonlyArray<T>,
): T | undefined => {
  const byId = new Map(tree.map((each) => [each.id, each]));
  const seen = new Set<string>();
  for (let at: T | undefined = task; at !== undefined && !seen.has(at.id); ) {
    if (TaskPauses.isPaused(at)) return at;
    seen.add(at.id);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return undefined;
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
