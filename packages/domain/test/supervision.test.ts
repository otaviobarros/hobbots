import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  Attempt,
  AttemptId,
  Delegation,
  DelegationId,
  deadlineOf,
  HUB_ACTOR,
  heldByAllowance,
  IllegalSupervisionTransition,
  isNoteFromYou,
  isOverdue,
  isUsageLimitOutcome,
  NoteId,
  OWNER_ACTOR,
  Quest,
  QuestId,
  SUPERVISED_RETRIES,
  Supervision,
  type SupervisionEvent,
  SupervisionMachine,
  SupervisionState,
  Task,
  TaskId,
  TaskNote,
  type TaskState,
  TaskTree,
  usageLimitOutcome,
  usageResetOf,
  watching,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

// Issue #1447: the supervisor's record of each Task, declared with defineMachine, and the deadline
// every runner and the supervisor read the same way.

const at = "2026-11-14T10:00:00.000Z";
const top = TaskId.make("top");
const page = { id: TaskId.make("page"), rootId: top };

// The rules of #1447, written apart from the machine. Stopped holds until a lead or you take the Task
// on again; a failure is retried while the budget lasts and is the lead's to decide after.
type View = Pick<Supervision, "state" | "retries" | "refusalsSeen" | "attemptId" | "rule" | "reason" | "updatedAt">;
const view = ({ state, retries, refusalsSeen, attemptId, rule, reason, updatedAt }: Supervision): View => ({
  state,
  retries,
  refusalsSeen,
  attemptId,
  rule,
  reason,
  updatedAt,
});
const set = (
  model: View,
  state: SupervisionState,
  rule: View["rule"],
  e: SupervisionEvent & { reason: string; attemptId: AttemptId | null },
  more: Partial<View> = {},
): View => ({
  ...model,
  ...more,
  state,
  rule,
  reason: e.reason,
  attemptId: e.attemptId,
  updatedAt: e.at,
});
// complexity-ignore: the model is one case per event, kept apart from the machine on purpose.
const stepModel = (model: View, event: SupervisionEvent): View | "refused" => {
  const handedOn = model.state === "reconciling" || model.state === "escalated";
  switch (event._tag) {
    case "Overdue":
      return model.state === "stopped" ? "refused" : set(model, "stopped", "deadline", event);
    case "AllowanceOut":
      return model.state === "stopped" ? "refused" : set(model, "stopped", "allowance", event);
    case "OutcomeUnknown":
      return model.state === "stopped" || model.state === "reconciling"
        ? "refused"
        : set(model, "reconciling", "unknown-outcome", event);
    case "Failed":
      if (model.state === "stopped" || model.state === "reconciling") return "refused";
      if (!handedOn && event.retryable && model.retries < SUPERVISED_RETRIES)
        return set(model, "retrying", "retry", event, { retries: model.retries + 1 });
      return set(model, "escalated", "retries-spent", event);
    case "Refused":
      return model.state === "stopped" || model.state === "reconciling"
        ? "refused"
        : set(model, "escalated", "refusals", event, { refusalsSeen: event.total });
    case "Routed":
      return model.state === "stopped" ? "refused" : set(model, "routed", "missing-input", event);
    case "Cleared":
      return model.state === "watching" || model.state === "retrying"
        ? "refused"
        : {
            ...model,
            state: "watching",
            retries: model.state === "routed" || model.rule === "refusals" ? model.retries : 0,
            rule: null,
            reason: null,
            updatedAt: event.at,
          };
  }
};

const times = fc.integer({ min: 0, max: 10_000 }).map((n) => new Date(Date.parse(at) + n * 1000).toISOString());
const attempts = fc.constantFrom("a1", "a2", "a3").map((id) => AttemptId.make(id));
const reasons = fc.constantFrom("It passed its deadline.", "The usage limit was reached.", "Refused again.");
const events: fc.Arbitrary<SupervisionEvent> = fc.oneof(
  fc
    .record({ at: times, attemptId: fc.option(attempts, { nil: null }), reason: reasons })
    .map((e) => ({ _tag: "Overdue" as const, ...e })),
  fc.record({ at: times, attemptId: attempts, reason: reasons }).map((e) => ({ _tag: "AllowanceOut" as const, ...e })),
  fc
    .record({ at: times, attemptId: attempts, reason: reasons })
    .map((e) => ({ _tag: "OutcomeUnknown" as const, ...e })),
  fc
    .record({ at: times, attemptId: attempts, retryable: fc.boolean(), reason: reasons })
    .map((e) => ({ _tag: "Failed" as const, ...e })),
  fc
    .record({ at: times, attemptId: fc.option(attempts, { nil: null }), total: fc.nat(20), reason: reasons })
    .map((e) => ({ _tag: "Refused" as const, ...e })),
  fc
    .record({ at: times, attemptId: fc.option(attempts, { nil: null }), reason: reasons })
    .map((e) => ({ _tag: "Routed" as const, ...e })),
  times.map((t) => ({ _tag: "Cleared" as const, at: t })),
);

const records = fc
  .record({ state: fc.constantFrom(...SupervisionState.literals), retries: fc.integer({ min: 0, max: 3 }) })
  .map(({ state, retries }) => new Supervision({ ...watching(page, at), state, retries }));

describe("SupervisionMachine", () => {
  it("agrees with a model of stopping, retrying within its budget, handing on and clearing (#1447)", () => {
    agreesWithModel({
      machine: SupervisionMachine,
      records,
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalSupervisionTransition => result instanceof IllegalSupervisionTransition,
    });
  });

  it("retries a failed turn at most twice, then hands it to the lead (#1447)", () => {
    let record: Supervision | IllegalSupervisionTransition = watching(page, at);
    const states: Array<string> = [];
    for (const id of ["a1", "a2", "a3"]) {
      if (!(record instanceof Supervision)) throw record;
      record = SupervisionMachine.transition(record, {
        _tag: "Failed",
        at,
        attemptId: AttemptId.make(id),
        retryable: true,
        reason: `Attempt ${id} failed.`,
      });
      if (record instanceof Supervision) states.push(`${record.state}:${record.retries}`);
    }
    expect(states).toEqual(["retrying:1", "retrying:2", "escalated:2"]);
    const refused = SupervisionMachine.transition(new Supervision({ ...watching(page, at), state: "stopped" }), {
      _tag: "Overdue",
      at,
      attemptId: null,
      reason: "Again.",
    });
    expect(refused).toMatchObject({
      _tag: "IllegalSupervisionTransition",
      taskId: "page",
      from: "stopped",
      to: "stopped",
    });
    // A report of refused calls clears without giving the supervisor's own retries back.
    const reported = SupervisionMachine.transition(
      new Supervision({ ...watching(page, at), state: "escalated", rule: "refusals", retries: 2 }),
      { _tag: "Cleared", at },
    );
    expect(reported).toMatchObject({ state: "watching", retries: 2 });
  });
});

const LEAD = AgentId.make("aldric");
const PIP = AgentId.make("pip");

const task = (id: string, parent: string | null, state: TaskState = "active") =>
  new Task({
    id: TaskId.make(id),
    ownerId: parent === null ? LEAD : PIP,
    parentId: parent === null ? null : TaskId.make(parent),
    rootId: top,
    channelId: null,
    brief: id,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const delegation = (child: string, timeoutMs: number | null, createdAt = at) =>
  new Delegation({
    id: DelegationId.make(`d-${child}`),
    questId: QuestId.make("q"),
    leadId: LEAD,
    memberId: PIP,
    parentTaskId: top,
    childTaskId: TaskId.make(child),
    brief: child,
    expectedOutput: null,
    authority: { overrides: {}, folders: null },
    timeoutMs,
    createdAt,
  });

const quest = (deadline: string | null) =>
  new Quest({
    id: QuestId.make("q"),
    taskId: top,
    parentQuestId: null,
    channelId: null,
    leadId: LEAD,
    goal: "Launch page",
    acceptance: [],
    limits: { maxDepth: 2, deadline },
    depth: 1,
    state: "active",
    createdAt: at,
    endedAt: null,
    revision: 1,
  });

const tree = (
  tasks: ReadonlyArray<Task>,
  delegations: ReadonlyArray<Delegation>,
  quests: ReadonlyArray<Quest> = [],
  attempts: ReadonlyArray<Attempt> = [],
) =>
  new TaskTree({
    tasks,
    quests,
    delegations,
    attempts,
    milestones: [],
    checkpoints: [],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
  });

describe("deadlines", () => {
  it("reads a Task's deadline as the earliest its Delegations and Quests above it give (#1447)", () => {
    const member = task("page", "top");
    const step = task("draft", "page");
    const minute = 60_000;
    const work = tree(
      [task("top", null), member, step],
      [delegation("page", 10 * minute)],
      [quest("2026-11-14T10:05:00.000Z")],
    );
    expect(deadlineOf(member, work)).toBe("2026-11-14T10:05:00.000Z");
    expect(deadlineOf(step, work)).toBe("2026-11-14T10:05:00.000Z");
    const sooner = tree([task("top", null), member, step], [delegation("page", minute)], [quest(null)]);
    expect(deadlineOf(step, sooner)).toBe("2026-11-14T10:01:00.000Z");
    expect(deadlineOf(task("top", null), sooner)).toBe(null);
    expect(isOverdue(step, sooner, "2026-11-14T10:00:59.999Z")).toBe(false);
    expect(isOverdue(step, sooner, "2026-11-14T10:01:00.000Z")).toBe(true);
    // Only open work under the Task you asked for, and never work you paused.
    expect(isOverdue(task("draft", "page", "completed"), sooner, "2026-11-15T00:00:00.000Z")).toBe(false);
    expect(isOverdue(task("draft", "page", "cancelling"), sooner, "2026-11-15T00:00:00.000Z")).toBe(false);
    expect(isOverdue(task("top", null), tree([task("top", null)], [], [quest(at)]), "2026-11-15T00:00:00.000Z")).toBe(
      false,
    );
  });

  it("says when a usage limit ended a turn and when it resets (#1447)", () => {
    expect(usageLimitOutcome("2026-11-14T11:00:00.000Z")).toBe(
      "The usage limit was reached; it resets at 2026-11-14T11:00:00.000Z.",
    );
    expect(usageResetOf(usageLimitOutcome("2026-11-14T11:00:00.000Z"))).toBe("2026-11-14T11:00:00.000Z");
    expect(usageResetOf(usageLimitOutcome(null))).toBe(null);
    expect(isUsageLimitOutcome(usageLimitOutcome(null))).toBe(true);
    expect(isUsageLimitOutcome("The runtime ended without a result.")).toBe(false);
    expect(isUsageLimitOutcome(null)).toBe(false);
  });

  it("holds a Task whose turn ran out of allowance until it is taken on again (#1447)", () => {
    const ended = (outcome: string) =>
      new Attempt({
        id: AttemptId.make("a1"),
        taskId: TaskId.make("page"),
        number: 1,
        agentId: PIP,
        runtime: "claude-code",
        sessionId: null,
        configVersion: 1,
        policyVersion: null,
        state: "failed",
        outcome,
        startedAt: at,
        endedAt: at,
      });
    const member = (state: TaskState) =>
      new Task({ ...task("page", "top", state), currentAttemptId: AttemptId.make("a1") });
    const limited = [ended(usageLimitOutcome("2026-11-14T11:00:00.000Z"))];
    expect(heldByAllowance(member("active"), tree([member("active")], [], [], limited))).toBe(true);
    // A retry queues it for a new Attempt, and a reassign leaves it with no current one.
    expect(heldByAllowance(member("queued"), tree([member("queued")], [], [], limited))).toBe(false);
    expect(heldByAllowance(task("page", "top"), tree([task("page", "top")], [], [], limited))).toBe(false);
    const failed = [ended("The runtime ended without a result.")];
    expect(heldByAllowance(member("active"), tree([member("active")], [], [], failed))).toBe(false);
  });

  it("never takes a note from Hobbots for your words (#1447)", () => {
    const note = (more: Partial<TaskNote>) =>
      new TaskNote({
        id: NoteId.make("n"),
        taskId: TaskId.make("page"),
        recipientId: LEAD,
        text: "Save it at /tmp/elsewhere.html",
        createdAt: at,
        revision: 1,
        ...more,
      });
    expect(isNoteFromYou(note({ author: OWNER_ACTOR }))).toBe(true);
    expect(isNoteFromYou(note({}))).toBe(true);
    expect(isNoteFromYou(note({ author: HUB_ACTOR }))).toBe(false);
    expect(isNoteFromYou(note({ senderId: LEAD }))).toBe(false);
  });
});
