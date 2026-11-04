import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  ApprovalId,
  ApprovalRequest,
  type ApprovalState,
  Attempt,
  AttemptId,
  DEFAULT_QUEST_LIMITS,
  Delegation,
  DelegationId,
  type HistoryEvent,
  type HistoryRecords,
  historyEvents,
  historyKind,
  historyNeedsYou,
  historyPage,
  Quest,
  QuestId,
  Question,
  QuestionId,
  Task,
  TaskId,
  type TaskState,
  ThreadId,
} from "../src/index.ts";

const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const threadId = ThreadId.make("t1");
const q1 = QuestId.make("q1");

const task = (
  id: string,
  ownerId: AgentId,
  parent: string | null,
  state: TaskState,
  createdAt: string,
  endedAt = createdAt,
) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: parent === null ? null : TaskId.make(parent),
    rootId: TaskId.make("launch"),
    threadId,
    brief: `Brief for ${id}`,
    state,
    dependsOn: [],
    result: state === "completed" ? { summary: `${id} is done`, attemptId: AttemptId.make(`${id}-1`) } : null,
    currentAttemptId: state === "queued" ? null : AttemptId.make(`${id}-${state === "failed" ? 3 : 1}`),
    createdAt,
    updatedAt: endedAt,
    revision: 1,
  });

const approval = (id: string, agentId: AgentId, taskId: string | null, state: ApprovalState, at: string) =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId,
    threadId,
    messageId: null,
    taskId: taskId === null ? null : TaskId.make(taskId),
    rootTaskId: taskId === null ? null : TaskId.make("launch"),
    stepId: id,
    tool: "Bash",
    operation: "run-commands",
    targets: [],
    arguments: { command: `run ${id}` },
    label: `Running ${id}`,
    reason: "Commands ask first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1",
    state,
    lifetime: state === "approved" ? "once" : null,
    denyReason: state === "denied" ? "Not now" : null,
    createdAt: at,
    decidedAt: state === "pending" ? null : at,
  });

const question = (id: string, answered: boolean, recipientId: AgentId | null, at: string) =>
  new Question({
    id: QuestionId.make(id),
    taskId: TaskId.make("copy"),
    askerId: QUILL,
    recipientId,
    chain: recipientId === null ? [ALDRIC] : [],
    text: `Asked ${id}`,
    state: answered ? "answered" : "open",
    answer: answered ? "Yes" : null,
    answeredBy: answered ? (recipientId === null ? { _tag: "User" } : { _tag: "Lead", agentId: ALDRIC }) : null,
    createdAt: at,
    answeredAt: answered ? at : null,
    revision: 1,
  });

/** Aldric leads the spring launch you asked for; Quill's copy failed after three tries. */
const records: HistoryRecords = {
  tasks: [
    task("launch", ALDRIC, null, "completed", "2026-09-01T09:00:00.000Z", "2026-11-03T17:10:00.000Z"),
    task("copy", QUILL, "launch", "failed", "2026-09-01T09:05:00.000Z", "2026-11-03T16:00:00.000Z"),
  ],
  delegations: [
    new Delegation({
      id: DelegationId.make("d-copy"),
      questId: q1,
      leadId: ALDRIC,
      memberId: QUILL,
      parentTaskId: TaskId.make("launch"),
      childTaskId: TaskId.make("copy"),
      brief: "Draft the copy",
      expectedOutput: null,
      authority: { overrides: {}, folders: null },
      timeoutMs: null,
      createdAt: "2026-09-01T09:05:00.000Z",
    }),
  ],
  quests: [
    new Quest({
      id: q1,
      taskId: TaskId.make("launch"),
      leadId: ALDRIC,
      parentQuestId: null,
      threadId,
      goal: "Spring launch",
      acceptance: [],
      limits: DEFAULT_QUEST_LIMITS,
      depth: 1,
      state: "completed",
      createdAt: "2026-09-01T09:04:00.000Z",
      endedAt: "2026-11-03T17:10:00.000Z",
      revision: 1,
    }),
  ],
  attempts: [
    new Attempt({
      id: AttemptId.make("copy-3"),
      taskId: TaskId.make("copy"),
      number: 3,
      agentId: QUILL,
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      state: "failed",
      outcome: "The preview link was not ready.",
      startedAt: "2026-11-03T15:50:00.000Z",
      endedAt: "2026-11-03T16:00:00.000Z",
    }),
  ],
  approvals: [
    approval("a-pending", QUILL, "copy", "pending", "2026-11-03T15:55:00.000Z"),
    approval("a-allowed", ALDRIC, null, "approved", "2026-10-02T08:30:00.000Z"),
  ],
  questions: [
    question("kept-by-lead", true, ALDRIC, "2026-09-02T10:00:00.000Z"),
    question("yours", true, null, "2026-09-02T11:00:00.000Z"),
  ],
  threadOwners: new Map([[threadId, ALDRIC]]),
};

const line = (event: HistoryEvent) => [event._tag, event.id, historyKind(event), event.quest?.goal ?? null];

describe("a hob's History", () => {
  // covers OR-001, UX-001
  it("[TC-OR-492] turns a lead's records into its events and its party's, newest first, each under its filter", () => {
    const events = historyEvents(ALDRIC, records);

    expect(events.map(line)).toEqual([
      ["QuestEnded", "quest-ended:q1", "quest", "Spring launch"],
      ["TaskEnded", "ended:launch", "work", "Spring launch"],
      ["TaskEnded", "ended:copy", "work", "Spring launch"],
      ["Approval", "approval:a-pending", "work", "Spring launch"],
      ["Approval", "approval:a-allowed", "you", null],
      // A question Aldric answered himself never reached you.
      ["Question", "question:yours", "you", "Spring launch"],
      ["TaskPickedUp", "picked-up:copy", "quest", "Spring launch"],
      ["QuestStarted", "quest-started:q1", "quest", "Spring launch"],
      ["TaskAsked", "asked:launch", "you", "Spring launch"],
    ]);
    const byId = new Map(events.map((event) => [event.id, event]));
    // A failed Task says why its last Attempt stopped, and how many it took.
    expect(byId.get("ended:copy")).toMatchObject({
      agentId: QUILL,
      state: "failed",
      summary: "The preview link was not ready.",
      attempts: 3,
      attemptId: "copy-3",
      threadId,
      // Quill's work opens in Aldric's chat, where you asked for it.
      threadAgentId: ALDRIC,
    });
    expect(byId.get("ended:launch")).toMatchObject({ state: "completed", summary: "launch is done" });
    expect(byId.get("quest-started:q1")).toMatchObject({ party: [QUILL] });
    expect(byId.get("picked-up:copy")).toMatchObject({ agentId: QUILL, leadId: ALDRIC });
    expect(byId.get("approval:a-allowed")).toMatchObject({ action: "run a-allowed", lifetime: "once" });
    expect(events.filter(historyNeedsYou).map((event) => event.id)).toEqual(["approval:a-pending"]);

    // A member's records hold its own Task and requests: it never shows the lead's Quest as its own.
    const quills: HistoryRecords = {
      ...records,
      tasks: records.tasks.filter((each) => each.ownerId === QUILL),
      approvals: records.approvals.filter((each) => each.agentId === QUILL),
    };
    expect(historyEvents(QUILL, quills).map((event) => event.id)).toEqual([
      "ended:copy",
      "approval:a-pending",
      "question:yours",
      "picked-up:copy",
    ]);
  });

  // covers UX-001
  it("[TC-OR-493] pages whole days in the reader's time zone, newest first, and counts the days left", () => {
    const events = historyEvents(ALDRIC, records);
    const page = (timeZone: string, before: number | null = null, filter: "all" | "you" = "all") =>
      historyPage(events, { timeZone: DateTime.zoneMakeNamedUnsafe(timeZone), filter, before, days: 2 });
    const days = (read: ReturnType<typeof page>) => read.days.map((day) => [day.day, day.events.length]);

    const first = page("UTC");
    expect(days(first)).toEqual([
      ["2026-11-03", 4],
      ["2026-10-02", 1],
    ]);
    expect(first).toMatchObject({ before: "2026-10-02T08:30:00.000Z", earlierDays: 2 });
    const second = page("UTC", Date.parse(first.before ?? ""));
    expect(days(second)).toEqual([
      ["2026-09-02", 1],
      ["2026-09-01", 3],
    ]);
    expect(second).toMatchObject({ before: null, earlierDays: 0 });

    // In Bangkok, the lead's last two events fall after midnight, on a day of their own.
    const bangkok = page("Asia/Bangkok");
    expect(days(bangkok)).toEqual([
      ["2026-11-04", 2],
      ["2026-11-03", 2],
    ]);
    expect(bangkok).toMatchObject({ before: "2026-11-03T15:55:00.000Z", earlierDays: 3 });

    // A filter pages only its own events.
    const yours = page("UTC", null, "you");
    expect(days(yours)).toEqual([
      ["2026-10-02", 1],
      ["2026-09-02", 1],
    ]);
    expect(yours).toMatchObject({ before: "2026-09-02T11:00:00.000Z", earlierDays: 1 });
  });
});
