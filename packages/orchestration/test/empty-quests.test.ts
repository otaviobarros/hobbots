import {
  AgentId,
  Checkpoint,
  CheckpointId,
  DEFAULT_QUEST_LIMITS,
  Quest,
  QuestId,
  type QuestState,
  Task,
  TaskId,
  TaskTree,
  TaskWait,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { emptyQuestFinding } from "../src/empty-quests.ts";

// Issue #576: the guards that decide when a member's Task reports that it leads a Quest with
// nobody brought in.

const at = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const PIP = AgentId.make("pip");
const NETTLE = AgentId.make("nettle");

const task = (id: string, ownerId: AgentId, parentId: string | null) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    rootId: TaskId.make("release"),
    threadId: ThreadId.make("chat"),
    brief: `Brief for ${id}`,
    state: "active",
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const RELEASE = task("release", FRODO, null);
const REVIEW = task("review", PIP, "release");

const quest = (taskId: TaskId, leadId: AgentId, state: QuestState = "active") =>
  new Quest({
    id: QuestId.make(`q-${taskId}`),
    taskId,
    leadId,
    parentQuestId: null,
    threadId: ThreadId.make("chat"),
    goal: "Review the release",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    depth: 1,
    state,
    createdAt: at,
    endedAt: null,
    revision: 1,
  });

const finding = (summary: string) =>
  new Checkpoint({
    id: CheckpointId.make("c-1"),
    taskId: REVIEW.id,
    attemptId: null,
    source: "unplanned",
    kind: "finding",
    milestoneId: null,
    summary,
    createdAt: at,
    revision: 1,
  });

const tree = (parts: Partial<Pick<TaskTree, "tasks" | "quests" | "checkpoints" | "waits">>) =>
  new TaskTree({
    tasks: parts.tasks ?? [RELEASE, REVIEW],
    quests: parts.quests ?? [quest(REVIEW.id, PIP)],
    delegations: [],
    attempts: [],
    milestones: [],
    checkpoints: parts.checkpoints ?? [],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: parts.waits ?? [],
  });

describe("a member's empty Quest", () => {
  // covers OR-002, OR-003
  it("[TC-OR-256] reports one finding for an active Quest under a member's Task with nobody brought in, naming the Quest and its goal", () => {
    const found = emptyQuestFinding(REVIEW, tree({}), at);
    expect(found).toMatchObject({
      taskId: REVIEW.id,
      source: "unplanned",
      kind: "finding",
      milestoneId: null,
      createdAt: at,
    });
    expect(found?.summary).toBe(
      "Started a Quest but has not brought anyone in (Quest q-review: Review the release). Its turn ended with nobody delegated to and nothing to wait on.",
    );
    // The member's own steps are not anyone brought in.
    expect(
      emptyQuestFinding(REVIEW, tree({ tasks: [RELEASE, REVIEW, task("step", PIP, "review")] }), at),
    ).not.toBeNull();
  });

  // covers OR-002, OR-003
  it.each([
    ["the Task is the one you asked for", RELEASE, tree({ quests: [quest(RELEASE.id, FRODO)] })],
    ["the Task leads no Quest", REVIEW, tree({ quests: [] })],
    ["its Quest has ended", REVIEW, tree({ quests: [quest(REVIEW.id, PIP, "cancelled")] })],
    ["the active Quest is another Task's", REVIEW, tree({ quests: [quest(RELEASE.id, FRODO)] })],
    ["someone was brought in", REVIEW, tree({ tasks: [RELEASE, REVIEW, task("commit", NETTLE, "review")] })],
    [
      "someone was brought in further down",
      REVIEW,
      tree({ tasks: [RELEASE, REVIEW, task("step", PIP, "review"), task("commit", NETTLE, "step")] }),
    ],
    [
      "it waits on something",
      REVIEW,
      tree({ waits: [new TaskWait({ taskId: REVIEW.id, on: [RELEASE.id], mode: "all", createdAt: at })] }),
    ],
    [
      "it reported this already",
      REVIEW,
      tree({ checkpoints: [finding("Started a Quest but has not brought anyone in (Quest q-review: …).")] }),
    ],
  ])("[TC-OR-257] reports nothing when %s", (_, subject, current) => {
    expect(emptyQuestFinding(subject, current, at)).toBeNull();
  });

  // covers OR-002
  it("[TC-OR-258] still reports when the Task's only other finding is about something else", () => {
    expect(
      emptyQuestFinding(REVIEW, tree({ checkpoints: [finding("The docs folder is read-only")] }), at),
    ).not.toBeNull();
  });
});
