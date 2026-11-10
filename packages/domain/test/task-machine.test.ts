import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AgentId,
  type AttemptId,
  IllegalTaskTransition,
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
  });

/** What the model tracks of a Task. */
interface TaskView {
  readonly state: TaskState;
  readonly ownerId: string;
  readonly currentAttemptId: string | null;
  readonly result: TaskResult | null;
  readonly updatedAt: string;
}

const view = (t: Task): TaskView => ({
  state: t.state,
  ownerId: t.ownerId,
  currentAttemptId: t.currentAttemptId,
  result: t.result,
  updatedAt: t.updatedAt,
});

// The rules as they were written by hand before Task moved onto defineMachine, kept apart from the
// machine so the two can disagree.
const ended = (state: TaskState) => state === "completed" || state === "cancelled" || state === "cancelling";
const stepModel = (before: TaskView, e: TaskEvent): TaskView | "refused" => {
  // Every change names the time it happened.
  const m = { ...before, updatedAt: e.at };
  const to = (state: TaskState, from: ReadonlyArray<TaskState>) =>
    from.includes(m.state) ? { ...m, state } : "refused";
  switch (e._tag) {
    case "Wait":
      return to("waiting", ["active"]);
    case "Block":
      return to("blocked", ["active", "waiting"]);
    case "Resume":
      return to("active", ["waiting", "blocked"]);
    case "Fail":
      return to("failed", ["queued", "active", "waiting", "blocked"]);
    case "RequestCancel":
      return to("cancelling", ["queued", "active", "waiting", "blocked"]);
    case "Cancel":
      return to("cancelled", ["queued", "cancelling"]);
    case "Start":
      return ended(m.state) || e.readiness._tag !== "Ready"
        ? "refused"
        : { ...m, state: "active", currentAttemptId: e.attemptId };
    case "Retry":
      return to("queued", ["failed"]);
    case "Reassign":
      return ended(m.state) ? "refused" : { ...m, state: "queued", ownerId: e.ownerId, currentAttemptId: null };
    case "Complete":
      return ["active", "waiting", "blocked"].includes(m.state)
        ? { ...m, state: "completed", result: e.result }
        : "refused";
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
    _tag: fc.constant("Complete" as const),
    at: times,
    result: attemptIds.map((attemptId) => ({ summary: "Done", attemptId })),
  }),
);

describe("TaskMachine", () => {
  it("agrees with a model of the rules over random runs of events", () => {
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

  it("exports one row per event, with Start guarded", () => {
    expect(TaskMachine.table.map((row) => row.event).sort()).toEqual([
      "Block",
      "Cancel",
      "Complete",
      "Fail",
      "Reassign",
      "RequestCancel",
      "Resume",
      "Retry",
      "Start",
      "Wait",
    ]);
    expect(TaskMachine.table.filter((row) => row.guarded).map((row) => row.event)).toEqual(["Start"]);
  });
});
