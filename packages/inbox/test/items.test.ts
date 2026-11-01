import {
  AgentId,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  Checkpoint,
  CheckpointId,
  type CheckpointKind,
  DEFAULT_QUEST_LIMITS,
  HandOff,
  type JournaledEvent,
  Quest,
  QuestId,
  Question,
  QuestionId,
  Task,
  TaskId,
  type TaskState,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { backpackItemsFor, tasksTouched } from "../src/index.ts";

const at = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
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
    currentAttemptId: AttemptId.make(`${id}-a1`),
    createdAt: at,
    updatedAt: at,
    revision,
  });

const campaign = task("campaign", ALDRIC, null);
const copy = task("copy", QUILL, "campaign");
// Quill's own step under its Task: its reports still go to Aldric, the nearest other owner.
const outline = task("outline", QUILL, "copy");
const quest = new Quest({
  id: QuestId.make("q1"),
  taskId: campaign.id,
  leadId: ALDRIC,
  parentQuestId: null,
  threadId,
  goal: "Campaign",
  acceptance: [],
  limits: DEFAULT_QUEST_LIMITS,
  depth: 1,
  state: "active",
  createdAt: at,
  endedAt: null,
  revision: 1,
});
const context = { tasks: [campaign, copy, outline], quests: [quest], toolCall: null };

const checkpoint = (kind: CheckpointKind, taskId = outline.id) =>
  new Checkpoint({
    id: CheckpointId.make(`c-${kind}`),
    taskId,
    attemptId: null,
    source: kind === "progress" || kind === "finding" ? "unplanned" : "automatic",
    kind,
    milestoneId: null,
    summary: kind,
    createdAt: at,
    revision: 7,
  });

const question = (recipientId: AgentId | null, state: "open" | "answered" = "open") =>
  new Question({
    id: QuestionId.make("q-quill"),
    taskId: copy.id,
    askerId: QUILL,
    recipientId,
    chain: [],
    text: "Which market?",
    state,
    answer: state === "answered" ? "EU" : null,
    answeredBy: state === "answered" ? { _tag: "User" } : null,
    createdAt: at,
    answeredAt: state === "answered" ? at : null,
    revision: 9,
  });

const artifact = new ArtifactRef({
  id: ArtifactId.make("copy-doc"),
  taskId: copy.id,
  attemptId: AttemptId.make("copy-a1"),
  kind: "file",
  label: "Copy",
  value: "/work/copy.md",
  createdAt: at,
});

const items = (event: JournaledEvent, toolCall: { agentId: AgentId; key: string } | null = null) =>
  backpackItemsFor([event], { ...context, toolCall }).map((item) => ({
    to: item.recipientId,
    kind: item.payload._tag,
    task: item.taskId,
    quest: item.questId,
    key: item.dedupeKey,
  }));

describe("backpackItemsFor", () => {
  it("gives a delegated Task or a planned step to its owner, and the Task you asked for to no one", () => {
    expect(items({ _tag: "TaskCreated", task: copy, delegation: null, milestones: [] })).toEqual([
      { to: QUILL, kind: "task", task: "copy", quest: "q1", key: "task:copy:v1:task" },
    ]);
    expect(items({ _tag: "TaskCreated", task: campaign, delegation: null, milestones: [] })).toEqual([]);
  });

  it("gives a result to the parent's owner, and a failure only when the Task itself moves", () => {
    expect(
      items({ _tag: "TaskCompleted", task: task("copy", QUILL, "campaign", "completed", 4), artifacts: [] }),
    ).toMatchObject([{ to: ALDRIC, kind: "result", key: "task:copy:v4:result" }]);
    for (const state of ["failed", "blocked", "cancelled"] as const) {
      const moved = task("copy", QUILL, "campaign", state, 5);
      expect(items({ _tag: "TaskStateChanged", task: moved, attempt: null, quest: null, wait: null })).toMatchObject([
        { to: ALDRIC, kind: "failure" },
      ]);
    }
    const waiting = task("copy", QUILL, "campaign", "waiting", 5);
    expect(items({ _tag: "TaskStateChanged", task: waiting, attempt: null, quest: null, wait: null })).toEqual([]);
    // An Attempt that moves on under a blocked Task is not a second failure.
    const blocked = task("copy", QUILL, "campaign", "blocked", 6);
    const attempt = { _tag: "TaskStateChanged", task: blocked, attempt: {}, quest: null } as unknown as JournaledEvent;
    expect(items(attempt)).toEqual([]);
  });

  it("sends a member's report to its nearest lead: routine progress as progress, a finding as a checkpoint", () => {
    expect(items({ _tag: "CheckpointRecorded", checkpoint: checkpoint("finding"), milestone: null })).toEqual([
      { to: ALDRIC, kind: "checkpoint", task: "outline", quest: "q1", key: "checkpoint:c-finding:checkpoint" },
    ]);
    for (const kind of ["progress", "started", "waiting"] as const) {
      expect(items({ _tag: "CheckpointRecorded", checkpoint: checkpoint(kind), milestone: null })).toMatchObject([
        { to: ALDRIC, kind: "progress" },
      ]);
    }
    // The hub's ending checkpoints come as results and failures; the lead's own Task reports to no one.
    expect(items({ _tag: "CheckpointRecorded", checkpoint: checkpoint("done"), milestone: null })).toEqual([]);
    const own = checkpoint("finding", campaign.id);
    expect(items({ _tag: "CheckpointRecorded", checkpoint: own, milestone: null })).toEqual([]);
  });

  it("sends a question to the lead it is with, an answer to the asker, and leaves one with no lead to your Inbox", () => {
    expect(items({ _tag: "QuestionAsked", question: question(ALDRIC) })).toMatchObject([
      { to: ALDRIC, kind: "question", key: "question:q-quill:v9:question" },
    ]);
    expect(items({ _tag: "QuestionEscalated", question: question(null) })).toEqual([]);
    expect(items({ _tag: "QuestionAnswered", question: question(null, "answered") })).toMatchObject([
      { to: QUILL, kind: "answer", task: "copy" },
    ]);
  });

  it("gives a hand-off to the receiving Task's owner", () => {
    const handOff = new HandOff({ artifactId: artifact.id, toTaskId: outline.id, createdAt: at });
    expect(items({ _tag: "HandedOff", handOff, artifact })).toEqual([
      { to: QUILL, kind: "hand-off", task: "outline", quest: "q1", key: "hand-off:copy-doc:outline:hand-off" },
    ]);
  });

  it("keys an item from a tool call by the call's key and the item's role in it", () => {
    expect(
      items({ _tag: "TaskCreated", task: outline, delegation: null, milestones: [] }, { agentId: QUILL, key: "k1" }),
    ).toMatchObject([{ key: "tool:quill:k1:task:task:outline:v1" }]);
  });

  it("names the Tasks a change touches, once each", () => {
    expect(
      tasksTouched([
        { _tag: "TaskCreated", task: copy, delegation: null, milestones: [] },
        { _tag: "CheckpointRecorded", checkpoint: checkpoint("started", copy.id), milestone: null },
        { _tag: "QuestionAsked", question: question(ALDRIC) },
        { _tag: "AgentUpserted", agent: {} } as unknown as JournaledEvent,
      ]),
    ).toEqual(["copy"]);
  });
});
