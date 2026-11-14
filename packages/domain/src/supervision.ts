import { Schema } from "effect";
import { defineMachine } from "./machine.ts";
import type { TaskTree } from "./quest.ts";
import { AttemptId, ancestorsOf, isCancellingTask, isTerminalTask, type Task, TaskId, TaskPauses } from "./task.ts";
import { questsAbove } from "./task-tools.ts";

/**
 * The supervisor (#1447): the hub's own watch over the work under the Task you asked for, which
 * enforces delegation deadlines and recovers from what goes wrong by fixed rules. It never calls a
 * model: every decision follows from the records, and every word it writes is written here or in
 * the supervisor. It keeps one `Supervision` per Task it acted on, so each rule acts once on each
 * fact, a retry budget holds across restarts, and a lead is told once.
 */

/** How many times the supervisor retries a Task whose turn failed before it asks the lead to decide. */
export const SUPERVISED_RETRIES = 2;

/** How many failed turns in a row a member's Task may have before the supervisor stops it. */
export const FAILED_TURNS_LIMIT = 3;

/** How many refused Task tool calls a Task's hob may make before its lead is told. */
export const REFUSALS_LIMIT = 3;

/**
 * Where the supervisor stands on a Task. `watching` while nothing needs it; `retrying` after it
 * retried a failed turn itself; `routed` once it passed a question on to someone who can answer it;
 * `reconciling` while what an Attempt did is not known; `escalated` once it handed a decision to the
 * lead; `stopped` once the Task passed its deadline or its hob's usage allowance ran out.
 */
export const SupervisionState = Schema.Literals([
  "watching",
  "retrying",
  "routed",
  "reconciling",
  "escalated",
  "stopped",
]);
export type SupervisionState = typeof SupervisionState.Type;

/** The rule that last acted on a Task. */
export const SupervisionRule = Schema.Literals([
  "deadline",
  "allowance",
  "unknown-outcome",
  "retry",
  "retries-spent",
  "refusals",
  "missing-input",
]);
export type SupervisionRule = typeof SupervisionRule.Type;

export class Supervision extends Schema.Class<Supervision>("Supervision")({
  taskId: TaskId,
  /** The top Task of its tree, which the supervisor reads it with. */
  rootId: TaskId,
  /** Only `SupervisionMachine` changes it. */
  state: SupervisionState,
  /** The retries the supervisor made itself since a lead or you last decided. */
  retries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The refused calls already reported to the lead, counting each try. */
  refusalsSeen: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The Attempt the last rule acted on, so one Attempt is acted on once; null when none ran. */
  attemptId: Schema.NullOr(AttemptId),
  /** The rule that last acted, and what it told; null while it watches. */
  rule: Schema.NullOr(SupervisionRule),
  reason: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
}) {}

/** The supervisor's first look at a Task: nothing acted on yet. */
export const watching = (task: Pick<Task, "id" | "rootId">, at: string): Supervision =>
  new Supervision({
    taskId: task.id,
    rootId: task.rootId,
    state: "watching",
    retries: 0,
    refusalsSeen: 0,
    attemptId: null,
    rule: null,
    reason: null,
    updatedAt: at,
  });

/** What the supervisor found. Each event names the time and the Attempt it is about, if any. */
export type SupervisionEvent =
  /** The Task passed its deadline: its turn is stopped and it fails, which tells its lead. */
  | { readonly _tag: "Overdue"; readonly at: string; readonly attemptId: AttemptId | null; readonly reason: string }
  /** Its hob's usage limit ended its turn: nothing retries it before the allowance refills. */
  | { readonly _tag: "AllowanceOut"; readonly at: string; readonly attemptId: AttemptId; readonly reason: string }
  /** Whether its Attempt stopped, or what it did, is not known: nothing starts again on its own. */
  | { readonly _tag: "OutcomeUnknown"; readonly at: string; readonly attemptId: AttemptId; readonly reason: string }
  /**
   * Its turn failed. One the supervisor may retry (`retryable`) is retried while its budget lasts;
   * past it, or when it may not, the lead decides.
   */
  | {
      readonly _tag: "Failed";
      readonly at: string;
      readonly attemptId: AttemptId;
      readonly retryable: boolean;
      readonly reason: string;
    }
  /** Its hob's Task tool calls were refused again and again: `total` counts every try so far. */
  | {
      readonly _tag: "Refused";
      readonly at: string;
      readonly attemptId: AttemptId | null;
      readonly total: number;
      readonly reason: string;
    }
  /** A question about it waited on someone who cannot answer, and went on to who can. */
  | { readonly _tag: "Routed"; readonly at: string; readonly attemptId: AttemptId | null; readonly reason: string }
  /** A lead or you took it on again, or what was stuck moved: the supervisor watches afresh. */
  | { readonly _tag: "Cleared"; readonly at: string };

/** A change the supervisor's record of a Task does not allow. */
export class IllegalSupervisionTransition extends Schema.TaggedError<IllegalSupervisionTransition>()(
  "IllegalSupervisionTransition",
  { taskId: TaskId, from: SupervisionState, to: SupervisionState },
) {}

type Acted = Extract<SupervisionEvent, { readonly reason: string }>;

const acted = (
  record: Supervision,
  to: SupervisionState,
  rule: SupervisionRule,
  event: Acted,
  more: Partial<Pick<Supervision, "retries" | "refusalsSeen">> = {},
) =>
  new Supervision({
    ...record,
    ...more,
    state: to,
    rule,
    reason: event.reason,
    attemptId: event.attemptId,
    updatedAt: event.at,
  });

/** Every state but `stopped`: a Task stopped for its deadline or allowance waits for a lead or you. */
const WATCHED: ReadonlyArray<SupervisionState> = ["watching", "retrying", "routed", "reconciling", "escalated"];
/** The states in which the supervisor may still retry: none in which it handed the Task on. */
const RETRYING: ReadonlyArray<SupervisionState> = ["watching", "retrying", "routed"];

/** The supervisor's record of a Task (#1447), declared once (ADR 037). */
export const SupervisionMachine = defineMachine<
  SupervisionState,
  SupervisionEvent,
  Supervision,
  IllegalSupervisionTransition
>({
  name: "Supervision",
  states: {
    watching: "Nothing needs the supervisor",
    retrying: "The supervisor retried a failed turn itself, within its budget",
    routed: "A question waited on someone who cannot answer; the supervisor passed it on",
    reconciling: "What an Attempt did, or whether it stopped, is not known; nothing restarts it on its own",
    escalated: "The supervisor handed a decision to the lead: retries spent, or calls refused again and again",
    stopped: "Past its deadline, or out of usage allowance: stopped, and the lead told why",
  },
  field: "state",
  events: {
    Overdue: { from: WATCHED, to: "stopped", apply: (record, e) => acted(record, "stopped", "deadline", e) },
    AllowanceOut: { from: WATCHED, to: "stopped", apply: (record, e) => acted(record, "stopped", "allowance", e) },
    OutcomeUnknown: {
      from: ["watching", "retrying", "routed", "escalated"],
      to: "reconciling",
      apply: (record, e) => acted(record, "reconciling", "unknown-outcome", e),
    },
    // The budget is the machine's: a retry while it lasts, the lead's decision after.
    Failed: [
      {
        from: RETRYING,
        to: "retrying",
        guard: (record, e) => e.retryable && record.retries < SUPERVISED_RETRIES,
        apply: (record, e) => acted(record, "retrying", "retry", e, { retries: record.retries + 1 }),
      },
      {
        from: [...RETRYING, "escalated"],
        to: "escalated",
        apply: (record, e) => acted(record, "escalated", "retries-spent", e),
      },
    ],
    Refused: {
      from: [...RETRYING, "escalated"],
      to: "escalated",
      apply: (record, e) => acted(record, "escalated", "refusals", e, { refusalsSeen: e.total }),
    },
    Routed: { from: RETRYING, to: "routed", apply: (record, e) => acted(record, "routed", "missing-input", e) },
    // A fresh budget: the lead or you decided, so earlier retries no longer count against the Task.
    Cleared: {
      from: ["routed", "reconciling", "escalated", "stopped"],
      to: "watching",
      apply: (record, e) =>
        new Supervision({ ...record, state: "watching", retries: 0, rule: null, reason: null, updatedAt: e.at }),
    },
  },
  illegal: (record, _, to) => new IllegalSupervisionTransition({ taskId: record.taskId, from: record.state, to }),
});

/** Whether the supervisor already stopped the Task: past its deadline, or out of allowance. */
export const isStoppedSupervision = (record: Supervision): boolean => record.state === "stopped";

/** Whether the supervisor passed a question about the Task on, and waits for it to be answered. */
export const isRoutedSupervision = (record: Supervision): boolean => record.state === "routed";

/**
 * Whether the supervisor handed the Task on and waits for a new Attempt on it: to reconcile what an
 * Attempt did, for the lead's decision, or after a stop.
 */
export const awaitsNewAttempt = (record: Supervision): boolean =>
  record.state === "reconciling" || record.state === "escalated" || record.state === "stopped";

/** When a Task's work must be done (ISO 8601), or null when nothing above it sets a deadline. */
export const deadlineOf = (task: Task, tree: TaskTree): string | null => {
  const path = new Set<string>([task.id, ...ancestorsOf(task, tree.tasks).map((each) => each.id)]);
  // Each Delegation on the way down gives its member until its time limit runs out from when it was made.
  const given = tree.delegations.flatMap((delegation) =>
    path.has(delegation.childTaskId) && delegation.timeoutMs !== null
      ? [Date.parse(delegation.createdAt) + delegation.timeoutMs]
      : [],
  );
  const quests = questsAbove(task, tree.tasks, tree.quests).flatMap((quest) =>
    quest.limits.deadline === null ? [] : [Date.parse(quest.limits.deadline)],
  );
  const due = [...given, ...quests].filter((each) => !Number.isNaN(each));
  return due.length === 0 ? null : new Date(Math.min(...due)).toISOString();
};

/**
 * Whether a Task is past its deadline at `at` with its work not done: a Task under the one you asked
 * for, not ended, not being cancelled and not paused by you. No turn starts on it, and the
 * supervisor stops it (#1447).
 */
export const isOverdue = (task: Task, tree: TaskTree, at: string): boolean => {
  if (task.parentId === null || isTerminalTask(task.state) || isCancellingTask(task.state)) return false;
  if (TaskPauses.isPaused(task)) return false;
  const due = deadlineOf(task, tree);
  return due !== null && Date.parse(due) <= Date.parse(at);
};

const USAGE_LIMIT = "The usage limit was reached";

/** Why a turn ended when its runtime's usage limit was reached, on its Attempt. */
export const usageLimitOutcome = (resetsAt: string | null): string =>
  resetsAt === null
    ? `${USAGE_LIMIT}; the provider did not say when it resets.`
    : `${USAGE_LIMIT}; it resets at ${resetsAt}.`;

/** Whether an Attempt's outcome says the runtime's usage limit ended it. */
export const isUsageLimitOutcome = (outcome: string | null): boolean => outcome?.startsWith(USAGE_LIMIT) === true;

/** When the usage allowance refills, as an Attempt's outcome says, or null when it does not say. */
export const usageResetOf = (outcome: string | null): string | null =>
  outcome === null ? null : (/it resets at (\S+)\.$/.exec(outcome)?.[1] ?? null);

/**
 * Why an Attempt Hobbots was running ended when the hub stopped: what it did after its last record
 * is not known.
 */
export const HUB_STOPPED_OUTCOME = "Hobbots stopped while this ran.";
