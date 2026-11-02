import {
  AgentId,
  AttemptId,
  BackpackItem,
  BackpackItemId,
  Task,
  TaskId,
  type TaskState,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { lateness, lateWorkOf } from "../src/index.ts";

const at = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const ROOK = AgentId.make("rook");
const threadId = ThreadId.make("t1");

const task = (id: string, ownerId: AgentId, parentId: string | null, state: TaskState = "active", revision = 1) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    rootId: TaskId.make("campaign"),
    threadId,
    brief: id,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision,
  });

/** A result reports up to the Task above; a message is about the recipient's own Task. */
const item = (recipientId: AgentId, taskId: string | null, kind: "result" | "message" = "result") =>
  new BackpackItem({
    id: BackpackItemId.make("i1"),
    recipientId,
    kind,
    actionable: true,
    priority: 1,
    state: "pending",
    taskId: taskId === null ? null : TaskId.make(taskId),
    questId: null,
    attemptId: AttemptId.make("a1"),
    threadId,
    dedupeKey: "k",
    payload: { _tag: "message", senderId: null, text: "hi" },
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    blockers: [],
    disposition: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

describe("lateness", () => {
  const copy = task("copy", QUILL, "campaign", "completed", 4);

  it("checks a lead's item against the nearest Task it owns, and finds it current while that Task runs", () => {
    expect(lateness(item(ALDRIC, "copy"), [task("campaign", ALDRIC, null), copy])).toBeNull();
    expect(
      lateness(item(QUILL, "copy", "message"), [task("campaign", ALDRIC, null), task("copy", QUILL, "campaign")]),
    ).toBeNull();
  });

  it("finds an item late once the Task it is checked against has ended, at that Task's version", () => {
    expect(lateness(item(ALDRIC, "copy"), [task("campaign", ALDRIC, null, "cancelled", 7), copy])).toEqual({
      taskRevision: 7,
    });
    expect(lateness(item(QUILL, "copy", "message"), [task("campaign", ALDRIC, null), copy])).toEqual({
      taskRevision: 4,
    });
  });

  it("finds an item late once its recipient no longer owns any Task on its way up, as after a reassignment", () => {
    const reassigned = task("copy", ADA, "campaign", "active", 5);
    expect(lateness(item(QUILL, "copy", "message"), [task("campaign", ALDRIC, null), reassigned])).toEqual({
      taskRevision: 5,
    });
  });

  // covers OR-006
  it("[TC-IN-140] finds an item late once a cancel was asked for the Task it is checked against", () => {
    const tree = [task("campaign", ALDRIC, null, "cancelling", 9), task("copy", QUILL, "campaign", "cancelled", 8)];
    expect(lateness(item(ALDRIC, "copy"), tree)).toEqual({ taskRevision: 9 });
    expect(lateness(item(QUILL, "copy", "message"), tree)).toEqual({ taskRevision: 8 });
  });

  it("never finds an item outside any Task late", () => {
    expect(lateness(item(QUILL, null, "message"), [])).toBeNull();
  });
});

describe("the late work of a Task that is over", () => {
  const about = (items: ReadonlyArray<BackpackItem>) => items.map((each) => [each.recipientId, each.taskId]);
  // Quill's note waits under his Task, Rook's under his; Aldric waits for Quill's result.
  const work = [item(QUILL, "copy", "message"), item(ROOK, "ads", "message"), item(ALDRIC, "copy")];

  // covers OR-006, EX-001
  it("[TC-OR-185] takes only the cancelled Task's own late work, and leaves a failed sibling's for its retry", () => {
    const tree = [
      task("campaign", ALDRIC, null),
      task("copy", QUILL, "campaign", "cancelled"),
      task("ads", ROOK, "campaign", "failed"),
    ];
    const copy = tree[1];
    if (copy === undefined) throw new Error("no Task");
    // Rook's work is late against his failed Task, but a retry takes it up again.
    expect(lateness(item(ROOK, "ads", "message"), tree)).not.toBeNull();
    expect(about(lateWorkOf(copy, tree, work))).toEqual([[QUILL, "copy"]]);

    // Once the Quest itself is cancelled nothing can retry Rook's Task, so his work is late too.
    const cancelled = [task("campaign", ALDRIC, null, "cancelling"), ...tree.slice(1)];
    const top = cancelled[0];
    if (top === undefined) throw new Error("no Task");
    expect(about(lateWorkOf(top, cancelled, work))).toEqual([
      [QUILL, "copy"],
      [ROOK, "ads"],
      [ALDRIC, "copy"],
    ]);
  });
});
