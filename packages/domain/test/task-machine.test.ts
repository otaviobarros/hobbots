import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AgentId,
  type AttemptId,
  IllegalTaskTransition,
  PausedFrom,
  Task,
  type TaskEvent,
  TaskMachine,
  type TaskResult,
  type TaskState,
  TaskState as TaskStates,
  TaskTransitions,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = "2026-01-01T00:00:00.000Z";

/** A paused or pausing Task carries its pause; any other carries none. */
const pauseOf = (state: TaskState) =>
  state === "paused" || state === "pausing"
    ? { from: state === "pausing" ? ("active" as const) : ("waiting" as const), at, by: you, now: false }
    : null;

const you = { kind: "user" as const, id: "owner" };

const task = (state: TaskState) =>
  new Task({
    id: "task-1" as Task["id"],
    ownerId: "hob-1" as AgentId,
    parentId: null,
    rootId: "task-1" as Task["id"],
    threadId: null,
    brief: "Do the thing",
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1 as Task["revision"],
    pause: pauseOf(state),
  });

/** What the model tracks of a Task. */
interface TaskView {
  readonly state: TaskState;
  readonly ownerId: string;
  readonly currentAttemptId: string | null;
  readonly result: TaskResult | null;
  readonly pause: Task["pause"];
  readonly updatedAt: string;
}

const view = (t: Task): TaskView => ({
  state: t.state,
  ownerId: t.ownerId,
  currentAttemptId: t.currentAttemptId,
  result: t.result,
  pause: t.pause,
  updatedAt: t.updatedAt,
});

// The rules as they were written by hand before Task moved onto defineMachine, kept apart from the
// machine so the two can disagree.
// A paused Task (#1446) starts nothing and changes no hands until you resume it.
const open = (state: TaskState) => ["queued", "active", "waiting", "blocked", "failed"].includes(state);
// complexity-ignore: the model is one case per event, kept apart from the machine on purpose.
const stepModel = (before: TaskView, e: TaskEvent): TaskView | "refused" => {
  // Every change names the time it happened.
  const m = { ...before, updatedAt: e.at };
  const to = (state: TaskState, from: ReadonlyArray<TaskState>) =>
    from.includes(m.state) ? { ...m, state } : "refused";
  // What ends a Task, or asks it to end, drops its pause.
  const ends = (state: TaskState, from: ReadonlyArray<TaskState>) =>
    from.includes(m.state) ? { ...m, state, pause: null } : "refused";
  // A turn still running as you paused moves where Resume takes it back to.
  const repause = (from: PausedFrom) => (m.pause === null ? m : { ...m, pause: { ...m.pause, from } });
  switch (e._tag) {
    case "Wait":
      return m.state === "pausing" ? repause("waiting") : to("waiting", ["active"]);
    case "Block":
      return m.state === "pausing" ? repause("blocked") : to("blocked", ["active", "waiting"]);
    case "Resume":
      return to("active", ["waiting", "blocked"]);
    case "Fail":
      return ends("failed", ["queued", "active", "waiting", "blocked", "pausing", "paused"]);
    case "RequestCancel":
      return ends("cancelling", ["queued", "active", "waiting", "blocked", "pausing", "paused"]);
    case "Cancel":
      return ends("cancelled", ["queued", "paused", "cancelling"]);
    case "Start":
      return !open(m.state) || e.readiness._tag !== "Ready"
        ? "refused"
        : { ...m, state: "active", currentAttemptId: e.attemptId };
    case "Retry":
      return to("queued", ["failed"]);
    case "Reassign":
      return !open(m.state) ? "refused" : { ...m, state: "queued", ownerId: e.ownerId, currentAttemptId: null };
    case "Complete":
      return ["active", "waiting", "blocked", "pausing"].includes(m.state)
        ? { ...m, state: "completed", result: e.result, pause: null }
        : "refused";
    case "Pause": {
      const pause = { at: e.at, by: e.by, now: e.now };
      if (m.state === "active" && e.running) return { ...m, state: "pausing", pause: { ...pause, from: "active" } };
      return m.state === "queued" || m.state === "active" || m.state === "waiting" || m.state === "blocked"
        ? { ...m, state: "paused", pause: { ...pause, from: m.state } }
        : "refused";
    }
    case "PauseSettled": {
      if (m.state !== "pausing") return "refused";
      if (m.pause === null) return { ...m, state: "paused" };
      const from = m.pause.from === "active" ? e.otherwise : m.pause.from;
      return { ...m, state: "paused", pause: { ...m.pause, from } };
    }
    case "Unpause":
      if (m.state === "pausing") return { ...m, state: "active", pause: null };
      return m.state === "paused" ? { ...m, state: e.to, pause: null } : "refused";
  }
};

// Each event has its own time, so a rule that keeps the old time is caught.
const times = fc
  .integer({ min: 0, max: 10_000 })
  .map((minute) => new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString());
const attemptIds = fc.constantFrom("attempt-1", "attempt-2").map((id) => id as AttemptId);
const events: fc.Arbitrary<TaskEvent> = fc.oneof(
  fc
    .constantFrom("Wait", "Block", "Resume", "Fail", "RequestCancel", "Cancel", "Retry")
    .chain((tag) => times.map((at) => ({ _tag: tag, at }) as TaskEvent)),
  fc.record({
    _tag: fc.constant("Start" as const),
    at: times,
    attemptId: attemptIds,
    readiness: fc.constantFrom({ _tag: "Ready" as const }, { _tag: "Waiting" as const, on: ["task-2" as Task["id"]] }),
  }),
  fc.record({
    _tag: fc.constant("Reassign" as const),
    at: times,
    ownerId: fc.constantFrom("hob-1", "hob-2").map((id) => id as AgentId),
  }),
  fc.record({
    _tag: fc.constant("Pause" as const),
    at: times,
    by: fc.constant(you),
    now: fc.boolean(),
    running: fc.boolean(),
  }),
  fc.record({
    _tag: fc.constant("PauseSettled" as const),
    at: times,
    otherwise: fc.constantFrom(...PausedFrom.literals),
  }),
  fc.record({ _tag: fc.constant("Unpause" as const), at: times, to: fc.constantFrom(...PausedFrom.literals) }),
  fc.record({
    _tag: fc.constant("Complete" as const),
    at: times,
    result: attemptIds.map((attemptId) => ({ summary: "Done", attemptId })),
  }),
);

describe("TaskMachine", () => {
  it("[TC-OR-1446-01] agrees with a model of the rules, pauses included, over random runs of events", () => {
    agreesWithModel({
      machine: TaskMachine,
      records: fc.constantFrom(...TaskStates.literals).map(task),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalTaskTransition => result instanceof IllegalTaskTransition,
    });
  });

  it("names the state a refused event would have led to", () => {
    const refused = TaskTransitions.retry(task("active"), at);
    expect(refused).toEqual(
      new IllegalTaskTransition({ taskId: "task-1" as Task["id"], from: "active", to: "queued" }),
    );
  });

  it("exports a row for every event, with Start, Pause while a turn runs and each Resume guarded", () => {
    expect([...new Set(TaskMachine.table.map((row) => row.event))].sort()).toEqual([
      "Block",
      "Cancel",
      "Complete",
      "Fail",
      "Pause",
      "PauseSettled",
      "Reassign",
      "RequestCancel",
      "Resume",
      "Retry",
      "Start",
      "Unpause",
      "Wait",
    ]);
    expect(TaskMachine.table.filter((row) => row.guarded).map((row) => row.event)).toEqual([
      "Start",
      "Pause",
      "Unpause",
      "Unpause",
      "Unpause",
      "Unpause",
    ]);
  });
});
