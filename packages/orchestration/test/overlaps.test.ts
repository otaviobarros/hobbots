import {
  AgentId,
  AttemptId,
  FileChange,
  FileChangeId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { othersAtWork, overlapCheckpointId, overlapsOf } from "../src/overlaps.ts";

// Issue #570: which Tasks of the same work changed the same file, and which of them did it last.

const at = "2026-11-03T01:06:00.000Z";
const FRODO = AgentId.make("frodo");
const ROOK = AgentId.make("rook");
const PIP = AgentId.make("pip");

const task = (id: string, ownerId: AgentId, state: TaskState = "active", attempt: string | null = `${id}-1`) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: id === "site" ? null : TaskId.make("site"),
    rootId: TaskId.make("site"),
    threadId: ThreadId.make("chat"),
    brief: id,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: attempt === null ? null : AttemptId.make(attempt),
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const change = (owner: Task, folder: string, path: string, second: number, movedFrom: string | null = null) =>
  new FileChange({
    id: FileChangeId.make(`${owner.id}-${path}`),
    attemptId: owner.currentAttemptId ?? AttemptId.make("none"),
    taskId: owner.id,
    folder,
    path,
    kind: movedFrom === null ? "edited" : "moved",
    movedFrom,
    before: null,
    after: null,
    sharedWith: [],
    settled: true,
    recordedAt: `2026-11-03T01:06:0${second}.000Z`,
  });

const lead = task("site", FRODO);
const rook = task("badge", ROOK);
const pip = task("review", PIP);

describe("Overlapping changes", () => {
  it("leaves out the writer, its own hob's Tasks, ended Tasks and Tasks with no Attempt", () => {
    const tree = new TaskTree({
      tasks: [lead, rook, pip, task("step", PIP), task("old", ROOK, "completed"), task("queued", ROOK, "queued", null)],
      quests: [],
      delegations: [],
      attempts: [],
      milestones: [],
      checkpoints: [],
      questions: [],
      artifacts: [],
      handOffs: [],
      notes: [],
      waits: [],
    });
    expect(othersAtWork(tree, pip).map((each) => each.id)).toEqual(["site", "badge"]);
  });

  it("pins the file on the Task that changed it last, and matches full paths and moves", () => {
    const recorded = {
      taskId: pip.id,
      folder: "/work/test/web",
      changes: [change(pip, "/work/test/web", "badge.png", 2), change(pip, "/work/test/web", "new.md", 2, "old.md")],
    };
    const found = overlapsOf(pip, recorded, [
      { task: rook, changes: [change(rook, "/work/test", "web/badge.png", 1)] },
      { task: lead, changes: [change(lead, "/work/test/", "web/old.md", 3)] },
    ]);
    expect(found.map((each) => [each.writer.id, each.other.id, each.folder, each.path])).toEqual([
      ["review", "badge", "/work/test/web", "badge.png"],
      ["site", "review", "/work/test/", "web/old.md"],
    ]);
  });

  it("gives a pair of Tasks and a file one id, whichever of them wrote last", () => {
    const one = overlapCheckpointId({ writer: pip, other: rook, folder: "/work/test", path: "web/badge.png" });
    const other = overlapCheckpointId({ writer: rook, other: pip, folder: "/work/test/", path: "web/badge.png" });
    expect(one).toBe(other);
  });
});
