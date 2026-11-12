import { describe, expect, it } from "vitest";
import {
  AgentId,
  QuestId,
  type QuestState,
  questSummaryOf,
  type SummaryTree,
  sameSummary,
  TaskId,
  type TaskState,
  ThreadId,
} from "../src/index.ts";

const task = (id: string, parentId: string | null, state: TaskState) => ({
  id: TaskId.make(id),
  parentId: parentId === null ? null : TaskId.make(parentId),
  state,
});

const quest = (id: string, taskId: string, state: QuestState = "active") => ({
  id: QuestId.make(id),
  taskId: TaskId.make(taskId),
  leadId: AgentId.make("aldric"),
  parentQuestId: null,
  threadId: ThreadId.make("t1"),
  state,
});

const EMPTY: SummaryTree = { tasks: [], questions: [], approvals: [], artifacts: [] };

// Aldric leads the campaign; Quill drafts copy (with a step of its own) and Ada builds, leading a nested Quest with Pip.
const tree: SummaryTree = {
  ...EMPTY,
  tasks: [
    task("campaign", null, "active"),
    task("copy", "campaign", "completed"),
    task("copy-step", "copy", "completed"),
    task("build", "campaign", "blocked"),
    task("keywords", "build", "failed"),
    task("other", null, "active"),
  ],
};

const link = (taskId: string, value: string) => ({ taskId: TaskId.make(taskId), kind: "link" as const, value });

describe("questSummaryOf", () => {
  it("counts every Task under the Quest's own by tone, steps and nested Quests included", () => {
    const summary = questSummaryOf(quest("q1", "campaign"), tree);
    expect(summary.tones).toEqual({ needs: 1, working: 0, waiting: 0, done: 2, problem: 1, idle: 0 });
    // A nested Quest counts only what is under its own Task.
    expect(questSummaryOf(quest("q2", "build"), tree).tones).toEqual({
      needs: 0,
      working: 0,
      waiting: 0,
      done: 0,
      problem: 1,
      idle: 0,
    });
    expect(summary).toMatchObject({ questId: "q1", taskId: "campaign", leadId: "aldric", threadId: "t1" });
  });

  it("counts questions that reached you, pending approvals and failed Tasks as what needs you, in its own tree only", () => {
    const asks: SummaryTree = {
      ...tree,
      questions: [
        { taskId: TaskId.make("build"), recipientId: null, state: "open" },
        // Still with its lead, answered, or in another tree: none of them waits on you here.
        { taskId: TaskId.make("build"), recipientId: AgentId.make("aldric"), state: "open" },
        { taskId: TaskId.make("copy"), recipientId: null, state: "answered" },
        { taskId: TaskId.make("other"), recipientId: null, state: "open" },
      ],
      approvals: [
        { taskId: TaskId.make("campaign"), state: "pending" },
        { taskId: TaskId.make("copy"), state: "approved" },
        { taskId: null, state: "pending" },
      ],
    };
    // One question, the lead's own approval, and the failed keywords Task.
    expect(questSummaryOf(quest("q1", "campaign"), asks).needsYou).toBe(3);
    // An ended Quest asks nothing more.
    expect(questSummaryOf(quest("q1", "campaign", "completed"), asks).needsYou).toBe(0);
  });

  it("counts the pull requests completed Tasks returned as ready for review, each once", () => {
    const returned: SummaryTree = {
      ...tree,
      artifacts: [
        link("copy", "https://github.com/acme/shop/pull/12"),
        link("copy-step", "https://github.com/acme/shop/pull/12"),
        link("copy-step", "https://github.com/acme/shop/pull/13/files"),
        // A page, a text that names a pull request, and a pull request from a Task still blocked.
        link("copy", "https://github.com/acme/shop/issues/9"),
        { taskId: TaskId.make("copy"), kind: "text", value: "https://github.com/acme/shop/pull/14" },
        link("build", "https://github.com/acme/shop/pull/15"),
      ],
    };
    expect(questSummaryOf(quest("q1", "campaign"), returned).readyForReview).toBe(2);
    expect(questSummaryOf(quest("q1", "campaign"), tree).readyForReview).toBe(0);
  });

  it("is empty for a Quest whose Task is not in the tree", () => {
    expect(questSummaryOf(quest("q9", "missing"), tree)).toMatchObject({
      tones: { needs: 0, working: 0, waiting: 0, done: 0, problem: 0, idle: 0 },
      needsYou: 0,
      readyForReview: 0,
    });
  });
});

describe("sameSummary", () => {
  it("tells summaries apart by every field but none other", () => {
    const summary = questSummaryOf(quest("q1", "campaign"), tree);
    expect(sameSummary(summary, { ...summary, tones: { ...summary.tones } })).toBe(true);
    expect(sameSummary(summary, { ...summary, tones: { ...summary.tones, done: 3 } })).toBe(false);
    expect(sameSummary(summary, { ...summary, state: "completed" })).toBe(false);
    expect(sameSummary(summary, { ...summary, threadId: ThreadId.make("t2") })).toBe(false);
    expect(sameSummary(summary, { ...summary, needsYou: summary.needsYou + 1 })).toBe(false);
    expect(sameSummary(summary, { ...summary, readyForReview: summary.readyForReview + 1 })).toBe(false);
  });
});
