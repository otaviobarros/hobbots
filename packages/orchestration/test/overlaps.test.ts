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

/** `second` seconds into the minute the tests run in. */
const atSecond = (second: number) => `2026-11-03T01:06:${String(second).padStart(2, "0")}.000Z`;
const at = atSecond(0);
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
    id: FileChangeId.make(`${owner.id}-${path}-${second}`),
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
    recordedAt: atSecond(second),
  });

const lead = task("site", FRODO);
const rook = task("badge", ROOK);
const pip = task("review", PIP);
const tree = [lead, rook, pip];
/** A Task delegated `second` seconds into the minute, after its lead's earlier changes. */
const delegated = (each: Task, second: number) => new Task({ ...each, createdAt: atSecond(second) });

describe("Overlapping changes", () => {
  it("leaves out the writer, its own hob's Tasks and Tasks with no Attempt, and keeps ended ones", () => {
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
    expect(othersAtWork(tree, pip).map((each) => each.id)).toEqual(["site", "badge", "old"]);
  });

  it("pins the file on the Task that changed it last, and matches full paths and moves", () => {
    const recorded = {
      taskId: pip.id,
      folder: "/work/test/web",
      changes: [change(pip, "/work/test/web", "badge.png", 2), change(pip, "/work/test/web", "new.md", 2, "old.md")],
    };
    const found = overlapsOf(
      pip,
      recorded,
      [
        { task: rook, changes: [change(rook, "/work/test", "web/badge.png", 1)] },
        { task: lead, changes: [change(lead, "/work/test/", "web/old.md", 3)] },
      ],
      tree,
    );
    expect(found.map((each) => [each.writer.id, each.other.id, each.folder, each.path])).toEqual([
      ["review", "badge", "/work/test/web", "badge.png"],
      ["site", "review", "/work/test/", "web/old.md"],
    ]);
  });

  it("keeps a change recorded after its own Task ended, but not one made after the other Task ended", () => {
    // Rook's turn completed his Task at 01:06:00, and its last scan recorded the badge a second later.
    const done = task("badge", ROOK, "completed");
    const late = { taskId: done.id, folder: "/work/test", changes: [change(done, "/work/test", "web/badge.png", 1)] };
    const stepped = overlapsOf(
      done,
      late,
      [{ task: pip, changes: [change(pip, "/work/test", "web/badge.png", 0)] }],
      tree,
    );
    expect(stepped.map((each) => [each.writer.id, each.other.id])).toEqual([["badge", "review"]]);
    // Pip changes the badge after Rook's Task ended: Rook was no longer at work, so it is no overlap.
    const after = { taskId: pip.id, folder: "/work/test", changes: [change(pip, "/work/test", "web/badge.png", 2)] };
    expect(
      overlapsOf(pip, after, [{ task: done, changes: [change(done, "/work/test", "web/badge.png", 0)] }], tree),
    ).toEqual([]);
    // Both ended: nobody is left at work to tell.
    expect(overlapsOf(task("review", PIP, "failed"), late, [{ task: done, changes: late.changes }], tree)).toEqual([]);
  });

  // Issue #658: the lead's root Attempt stays open until its Quest ends, so a file it deleted before
  // it delegated was still one of its current changes when each member rebuilt that file.
  it("is no overlap for a lead's change from before it delegated the other Task", () => {
    const later = delegated(pip, 3);
    const cleared = change(lead, "/work/test", "web/badge.png", 1);
    const rebuilt = {
      taskId: pip.id,
      folder: "/work/test",
      changes: [change(later, "/work/test", "web/badge.png", 5)],
    };
    const tasks = [lead, later];
    expect(overlapsOf(later, rebuilt, [{ task: lead, changes: [cleared] }], tasks)).toEqual([]);
    // Heard the other way round, from the lead's side, it is none too.
    const fromLead = { taskId: lead.id, folder: "/work/test", changes: [cleared] };
    expect(overlapsOf(lead, fromLead, [{ task: later, changes: rebuilt.changes }], tasks)).toEqual([]);
    // A move's old path counts as the file it was, and is left out the same way.
    const moved = change(lead, "/work/test", "docs/NOTES.md", 2, "notes.txt");
    const notes = { taskId: pip.id, folder: "/work/test", changes: [change(later, "/work/test", "notes.txt", 6)] };
    expect(overlapsOf(later, notes, [{ task: lead, changes: [moved] }], tasks)).toEqual([]);
    // A Task under a member of the lead's is handed it the same way.
    const nested = new Task({ ...delegated(task("check", ROOK), 4), parentId: later.id });
    const checked = {
      taskId: nested.id,
      folder: "/work/test",
      changes: [change(nested, "/work/test", "web/badge.png", 6)],
    };
    expect(overlapsOf(nested, checked, [{ task: lead, changes: [cleared] }], [...tasks, nested])).toEqual([]);
  });

  it("is still one overlap for a change while both were at work, even one made before the other started", () => {
    const later = delegated(pip, 3);
    const rebuilt = {
      taskId: pip.id,
      folder: "/work/test",
      changes: [change(later, "/work/test", "web/badge.png", 5)],
    };
    // Frodo cleared the badge before he delegated Pip's Task, then rewrote it while Pip was at work.
    const leads = [change(lead, "/work/test", "web/badge.png", 1), change(lead, "/work/test", "web/badge.png", 4)];
    const found = overlapsOf(later, rebuilt, [{ task: lead, changes: leads }], [lead, later]);
    expect(found.map((each) => [each.writer.id, each.other.id, each.path])).toEqual([
      ["review", "site", "web/badge.png"],
    ]);
    // Rook, still at work on the badge he made, is not Pip's lead: Pip overwriting it is a clash.
    const made = [change(rook, "/work/test", "web/badge.png", 1)];
    const clash = overlapsOf(later, rebuilt, [{ task: rook, changes: made }], [lead, rook, later]);
    expect(clash.map((each) => [each.writer.id, each.other.id])).toEqual([["review", "badge"]]);
  });

  it("is no overlap for a hand-over: one Task completes, then the other changes the file", () => {
    // Rook's Task completed at 01:06:02, and Pip changed the badge after it, at 01:06:04.
    const done = new Task({ ...task("badge", ROOK, "completed"), updatedAt: atSecond(2) });
    const made = change(done, "/work/test", "web/badge.png", 1);
    const edited = { taskId: pip.id, folder: "/work/test", changes: [change(pip, "/work/test", "web/badge.png", 4)] };
    expect(overlapsOf(pip, edited, [{ task: done, changes: [made] }], [lead, done, pip])).toEqual([]);
  });

  it("gives a pair of Tasks and a file one id, whichever of them wrote last", () => {
    const one = overlapCheckpointId({ writer: pip, other: rook, folder: "/work/test", path: "web/badge.png" });
    const other = overlapCheckpointId({ writer: rook, other: pip, folder: "/work/test/", path: "web/badge.png" });
    expect(one).toBe(other);
  });
});
