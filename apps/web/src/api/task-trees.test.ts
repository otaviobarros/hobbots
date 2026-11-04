import { NoteId, TaskId, TaskNote, TaskWait } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  attempt,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  checkpoint,
  delegation,
  memberApproval,
  milestone,
  QUILL,
  quest,
  question,
  THREAD,
  task,
  tree,
} from "../test/quests.ts";
import { applyToThreadTrees, applyToTree, type TaskEvent } from "./task-trees.ts";

describe("applyToTree", () => {
  it("adds a member's Task with its delegation and milestones under a Task in the tree", () => {
    const created: TaskEvent = {
      _tag: "TaskCreated",
      task: task(COPY, { ownerId: QUILL }),
      delegation: delegation(QUILL, COPY, "Draft the copy"),
      milestones: [milestone(COPY, "Headlines", 0)],
    };
    const next = applyToTree(tree(), created);
    expect(next.tasks.map((each) => each.id)).toEqual([CAMPAIGN, COPY]);
    expect(next.delegations.map((each) => each.memberId)).toEqual([QUILL]);
    expect(next.milestones.map((each) => each.title)).toEqual(["Headlines"]);
    // Applying it again changes nothing.
    expect(applyToTree(next, created)).toEqual(next);
  });

  it("keeps a member's approval request live on its Task, its newer version winning, and leaves other trees alone", () => {
    const asked = applyToTree(blackFriday(), { _tag: "ApprovalRecorded", approval: memberApproval(COPY, QUILL) });
    expect(asked.approvals.map((each) => [each.id, each.state])).toEqual([["ap-copy", "pending"]]);
    const approved = memberApproval(COPY, QUILL, { state: "approved", revision: 2 });
    const decided = applyToTree(asked, { _tag: "ApprovalRecorded", approval: approved });
    expect(decided.approvals.map((each) => each.state)).toEqual(["approved"]);
    // A late copy of the pending version never takes the decision back.
    expect(applyToTree(decided, { _tag: "ApprovalRecorded", approval: memberApproval(COPY, QUILL) })).toBe(decided);
    const elsewhere = tree();
    expect(applyToTree(elsewhere, { _tag: "ApprovalRecorded", approval: memberApproval(COPY, QUILL) })).toBe(elsewhere);
  });

  it("leaves a tree alone for an event about another tree", () => {
    const start = tree();
    const other = task(COPY, { parentId: null });
    expect(applyToTree(start, { _tag: "TaskCreated", task: other, delegation: null, milestones: [] })).toBe(start);
    expect(applyToTree(start, { _tag: "QuestionAsked", question: question(BUILD, ADA, "Which discount?") })).toBe(
      start,
    );
  });

  it("keeps who a Task waits on live: a wait made or replaced after the read lands", () => {
    const waiting = (on: ReadonlyArray<TaskId>, revision: number): TaskEvent => ({
      _tag: "TaskStateChanged",
      task: task(CAMPAIGN, { state: "waiting", revision }),
      attempt: null,
      quest: null,
      wait: new TaskWait({ taskId: CAMPAIGN, on, mode: "all", createdAt: "2026-11-01T10:01:00.000Z" }),
    });
    const first = applyToTree(blackFriday(), waiting([COPY], 4));
    expect(first.waits.map((each) => each.on)).toEqual([[COPY]]);
    const replaced = applyToTree(first, waiting([COPY, BUILD], 6));
    expect(replaced.waits.map((each) => each.on)).toEqual([[COPY, BUILD]]);
    expect(applyToTree(replaced, waiting([BUILD], 5)).waits.map((each) => each.on)).toEqual([[COPY, BUILD]]);
    // A Task that ended waits for nothing, as the hub drops its wait (#702).
    const failed = applyToTree(replaced, {
      _tag: "TaskStateChanged",
      task: task(CAMPAIGN, { state: "failed", revision: 7 }),
      attempt: null,
      quest: null,
      wait: null,
    });
    expect(failed.waits).toEqual([]);
    const completed = applyToTree(replaced, {
      _tag: "TaskCompleted",
      task: task(CAMPAIGN, { state: "completed", revision: 7 }),
      artifacts: [],
    });
    expect(completed.waits).toEqual([]);
  });

  it("never moves a Task, its Attempt or a Question back to an older version", () => {
    const start = blackFriday();
    const done: TaskEvent = {
      _tag: "TaskStateChanged",
      task: task(COPY, { ownerId: QUILL, state: "blocked", revision: 5 }),
      attempt: attempt(COPY, "completed"),
      quest: null,
      wait: null,
    };
    const older: TaskEvent = {
      _tag: "TaskStateChanged",
      task: task(COPY, { ownerId: QUILL, state: "active", revision: 3 }),
      attempt: attempt(COPY, "running"),
      quest: null,
      wait: null,
    };
    const next = [done, older].reduce(applyToTree, start);
    expect(next.tasks.find((each) => each.id === COPY)?.state).toBe("blocked");
    expect(next.attempts.map((each) => each.state)).toEqual(["completed"]);

    const answered = question(BUILD, ADA, "Which discount?", {
      state: "answered",
      answer: "20%",
      answeredBy: { _tag: "Lead", agentId: ALDRIC },
      revision: 12,
    });
    const asked = question(BUILD, ADA, "Which discount?", { revision: 10 });
    const questions = [
      { _tag: "QuestionAnswered", question: answered } as const,
      { _tag: "QuestionAsked", question: asked } as const,
    ].reduce(applyToTree, start).questions;
    expect(questions.map((each) => each.state)).toEqual(["answered"]);
  });

  it("keeps checkpoints in journal order and a reached milestone reached", () => {
    const start = tree({ milestones: [milestone(CAMPAIGN, "Copy approved", 0)] });
    const reached = milestone(CAMPAIGN, "Copy approved", 0, true);
    const next = [
      { _tag: "CheckpointRecorded", checkpoint: checkpoint(CAMPAIGN, "finding", "Later", 9), milestone: null },
      {
        _tag: "CheckpointRecorded",
        checkpoint: checkpoint(CAMPAIGN, "milestone", "Copy approved", 7),
        milestone: reached,
      },
      {
        _tag: "TaskCreated",
        task: task(CAMPAIGN),
        delegation: null,
        milestones: [milestone(CAMPAIGN, "Copy approved", 0)],
      },
    ].reduce((each, event) => applyToTree(each, event as TaskEvent), start);
    expect(next.checkpoints.map((each) => each.revision)).toEqual([7, 9]);
    expect(next.milestones[0]?.reachedAt).not.toBeNull();
  });

  it("ends the Quest with its Task and adds a hand-off once", () => {
    const start = blackFriday();
    const artifact = {
      id: "art-1",
      taskId: COPY,
      attemptId: "a-copy",
      kind: "text",
      label: "Landing copy",
      value: "Save big",
      createdAt: "2026-11-01T10:01:00.000Z",
    } as const;
    const handOff = { artifactId: "art-1", toTaskId: BUILD, createdAt: "2026-11-01T10:01:00.000Z" } as const;
    const event = { _tag: "HandedOff", handOff, artifact } as unknown as TaskEvent;
    const next = [
      event,
      event,
      { _tag: "QuestCompleted", quest: quest({ state: "completed", revision: 9 }) } as const,
    ].reduce(applyToTree, start);
    expect(next.handOffs).toHaveLength(1);
    expect(next.artifacts.map((each) => each.label)).toEqual(["Landing copy"]);
    expect(next.quests[0]?.state).toBe("completed");
  });
});

describe("applyToTree with your controls", () => {
  it("moves a reassigned Task's party member to its new hob, and ignores an older copy", () => {
    const base = blackFriday();
    const given = delegation(QUILL, BUILD, "Build the campaign");
    const reassigned: TaskEvent = {
      _tag: "TaskStateChanged",
      task: task(BUILD, { ownerId: QUILL, state: "queued", revision: 5 }),
      attempt: null,
      quest: null,
      wait: null,
      control: { _tag: "Reassigned", from: ADA, delegation: given },
    };
    const next = applyToTree(base, reassigned);
    expect(next.tasks.find((each) => each.id === BUILD)?.ownerId).toBe(QUILL);
    expect(next.delegations.map((each) => [each.childTaskId, each.memberId])).toEqual([
      [COPY, QUILL],
      [BUILD, QUILL],
    ]);
    const older: TaskEvent = {
      ...reassigned,
      task: task(BUILD, { ownerId: ADA, revision: 4 }),
      control: { _tag: "Reassigned", from: QUILL, delegation: delegation(ADA, BUILD, "Build the campaign") },
    };
    expect(applyToTree(next, older)).toEqual(next);
  });
});

describe("applyToTree with a control's answer", () => {
  it("keeps the party current when the hub's answer arrives before the reassignment's own event", () => {
    const base = blackFriday();
    const moved = delegation(QUILL, BUILD, "Build the campaign");
    // Quill started on it before the answer was read: the answer holds a newer copy than the event.
    const started = task(BUILD, { ownerId: QUILL, state: "active", revision: 6 });
    const answer = tree({ ...base, tasks: [base.tasks[0] ?? task(CAMPAIGN), started], delegations: [moved] });
    const reassigned: TaskEvent = {
      _tag: "TaskStateChanged",
      task: task(BUILD, { ownerId: QUILL, state: "queued", revision: 5 }),
      attempt: null,
      quest: null,
      wait: null,
      control: { _tag: "Reassigned", from: ADA, delegation: moved },
    };
    const answered = applyToTree(base, { _tag: "ControlRecorded", tree: answer });
    const party = (each: typeof base) => each.delegations.map((d) => [d.childTaskId, d.memberId]);
    expect(answered.tasks.find((each) => each.id === BUILD)?.state).toBe("active");
    expect(party(answered)).toEqual([
      [COPY, QUILL],
      [BUILD, QUILL],
    ]);
    expect(applyToTree(answered, reassigned)).toEqual(answered);
  });

  it("leaves a newer copy alone, and a tree the answer is not about", () => {
    const base = blackFriday();
    const old = tree({
      ...base,
      tasks: [task(BUILD, { ownerId: QUILL, revision: 0 })],
      delegations: [delegation(QUILL, BUILD, "Build the campaign")],
    });
    expect(applyToTree(base, { _tag: "ControlRecorded", tree: old })).toEqual(base);
    const other = tree({ tasks: [task(TaskId.make("elsewhere"), { parentId: null })] });
    expect(applyToTree(other, { _tag: "ControlRecorded", tree: base })).toBe(other);
  });
});

describe("applyToTree with notes", () => {
  it("adds your note on a Task in the tree once, and leaves another tree's alone", () => {
    const start = blackFriday();
    const note = new TaskNote({
      id: NoteId.make("n1"),
      taskId: COPY,
      recipientId: ALDRIC,
      text: "Keep it short",
      createdAt: "2026-11-01T00:00:30.000Z",
      revision: 20,
    });
    const event = { _tag: "NoteLeft", note } as const;
    const once = applyToTree(start, event);
    expect(once.notes).toEqual([note]);
    expect(applyToTree(once, event).notes).toEqual([note]);
    const elsewhere = { _tag: "NoteLeft", note: new TaskNote({ ...note, taskId: TaskId.make("other") }) } as const;
    expect(applyToTree(start, elsewhere)).toBe(start);
  });

  it("shows a note picked up in its place, and an older copy changes nothing", () => {
    const left = (id: string, revision: number) =>
      new TaskNote({
        id: NoteId.make(id),
        taskId: COPY,
        recipientId: ALDRIC,
        text: "Keep it short",
        createdAt: "2026-11-01T00:00:30.000Z",
        revision,
      });
    const start = applyToTree(applyToTree(blackFriday(), { _tag: "NoteLeft", note: left("n1", 20) }), {
      _tag: "NoteLeft",
      note: left("n2", 21),
    });
    const picked = new TaskNote({ ...left("n1", 30), pickedUpBy: "turn-1", pickedUpAt: "2026-11-01T00:01:00.000Z" });
    const after = applyToTree(start, { _tag: "NotePickedUp", note: picked });
    expect(after.notes.map((note) => [note.id, note.pickedUpBy])).toEqual([
      ["n1", "turn-1"],
      ["n2", null],
    ]);
    expect(applyToTree(after, { _tag: "NoteLeft", note: left("n1", 20) }).notes[0]?.pickedUpBy).toBe("turn-1");
  });
});

describe("applyToThreadTrees", () => {
  it("adds a tree for a top Task started in the thread, once, and nothing for another thread's", () => {
    const top: TaskEvent = {
      _tag: "TaskCreated",
      task: task(CAMPAIGN, { parentId: null }),
      delegation: null,
      milestones: [],
    };
    const trees = applyToThreadTrees(THREAD, [], top);
    expect(trees.map((each) => each.tasks[0]?.id)).toEqual([CAMPAIGN]);
    expect(applyToThreadTrees(THREAD, trees, top)).toEqual(trees);
    expect(applyToThreadTrees("other" as typeof THREAD, [], top)).toEqual([]);
  });
});
