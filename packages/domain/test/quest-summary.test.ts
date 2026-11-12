import { describe, expect, it } from "vitest";
import {
  AgentId,
  type ArtifactReview,
  QuestId,
  type QuestState,
  questSummaryOf,
  RegisteredArtifactId,
  type RegisteredArtifactKind,
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

const EMPTY: SummaryTree = { tasks: [], questions: [], approvals: [], delivered: [] };

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

const made = (
  artifactId: string,
  taskId: string,
  kind: RegisteredArtifactKind,
  review: ArtifactReview = "waiting",
) => ({
  artifactId: RegisteredArtifactId.make(artifactId),
  taskId: TaskId.make(taskId),
  kind,
  review,
});

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

  // covers #1422
  it("counts each reviewable artifact completed Tasks made that still waits for you, once", () => {
    const delivered: SummaryTree = {
      ...tree,
      delivered: [
        // One pull request two Tasks made counts once; a doc, a page and code count too.
        made("pr-12", "copy", "pr"),
        made("pr-12", "copy-step", "pr"),
        made("plan", "copy-step", "doc"),
        made("landing", "copy", "page"),
        made("cart", "copy", "code"),
        // Reviewed, dismissed, of a kind you do not review, or from a Task still blocked or another tree.
        made("pr-13", "copy", "pr", "reviewed"),
        made("draft", "copy", "doc", "dismissed"),
        made("hero", "copy", "image"),
        made("mail", "copy", "email"),
        made("export", "copy", "file"),
        made("pr-15", "build", "pr"),
        made("pr-16", "other", "pr"),
      ],
    };
    expect(questSummaryOf(quest("q1", "campaign"), delivered).readyForReview).toBe(4);
    // A nested Quest counts only what its own tree made, once its Tasks complete.
    expect(questSummaryOf(quest("q2", "build"), delivered).readyForReview).toBe(0);
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
