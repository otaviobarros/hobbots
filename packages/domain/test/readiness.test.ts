import { describe, expect, it } from "vitest";
import {
  AgentId,
  AttemptId,
  IllegalTaskTransition,
  Task,
  TaskId,
  TaskReadiness,
  type TaskState,
  TaskTransitions,
} from "../src/index.ts";

// Issue #667: whether a Task can start is one pure read over its tree, which every start obeys.

const at = "2026-11-03T00:00:00.000Z";

const task = (id: string, state: TaskState, dependsOn: ReadonlyArray<string> = []) =>
  new Task({
    id: TaskId.make(id),
    ownerId: AgentId.make("frodo"),
    parentId: TaskId.make("top"),
    rootId: TaskId.make("top"),
    threadId: null,
    brief: id,
    state,
    dependsOn: dependsOn.map((each) => TaskId.make(each)),
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const readinessAfter = (...before: ReadonlyArray<Task>) =>
  TaskReadiness.of(
    task(
      "next",
      "queued",
      before.map((each) => each.id),
    ),
    before,
  );

describe("TaskReadiness", () => {
  it("is ready with nothing to come after, or once all of it completed", () => {
    expect(readinessAfter()).toEqual({ _tag: "Ready" });
    expect(readinessAfter(task("a", "completed"), task("b", "completed"))).toEqual({ _tag: "Ready" });
  });

  it("waits on what is still under way", () => {
    expect(readinessAfter(task("a", "completed"), task("b", "active"), task("c", "queued"))).toEqual({
      _tag: "Waiting",
      on: ["b", "c"],
    });
  });

  it("is blocked by a Task that is blocked, failed or was cancelled, and still lists the rest", () => {
    expect(readinessAfter(task("a", "blocked"), task("b", "active"))).toEqual({
      _tag: "Blocked",
      on: ["a", "b"],
      by: ["a"],
    });
    expect(readinessAfter(task("a", "failed"), task("b", "cancelled"))).toMatchObject({ by: ["a", "b"] });
  });

  it("lets a Task start only when it is ready", () => {
    const next = task("next", "queued", ["a"]);
    const attempt = AttemptId.make("attempt");
    const held = TaskReadiness.of(next, [task("a", "blocked")]);
    expect(TaskTransitions.start(next, attempt, at, held)).toBeInstanceOf(IllegalTaskTransition);
    const ready = TaskReadiness.of(next, [task("a", "completed")]);
    expect(TaskTransitions.start(next, attempt, at, ready)).toMatchObject({
      state: "active",
      currentAttemptId: attempt,
    });
  });

  it("lets a blocked Task complete, as its owner decides", () => {
    const result = { summary: "Keep them", attemptId: AttemptId.make("attempt") };
    expect(TaskTransitions.complete(task("a", "blocked"), result, at)).toMatchObject({ state: "completed", result });
  });
});
