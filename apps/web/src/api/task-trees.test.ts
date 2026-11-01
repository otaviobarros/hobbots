import { type TaskId, TaskWait } from "@hobbots/domain";
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
