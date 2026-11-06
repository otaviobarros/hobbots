import {
  AgentId,
  type BackpackItem,
  BackpackItemId,
  Checkpoint,
  CheckpointId,
  DEFAULT_QUEST_LIMITS,
  IDLE_QUEST,
  type LedgerEntry,
  Milestone,
  MilestoneId,
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
import { emptyQuestFinding, idleQuestOf } from "../src/empty-quests.ts";

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

// Issue #1081: the Task you asked for led a Quest whose lead wrote the plan and delegated nothing,
// so the Quest sat idle with nothing to wake it and nothing to tell you.
describe("the Quest you asked for with nothing moving it", () => {
  const OWN = quest(RELEASE.id, FRODO);
  const idleTree = (parts: Partial<Pick<TaskTree, "tasks" | "checkpoints">> = {}) =>
    tree({ tasks: parts.tasks ?? [RELEASE], quests: [OWN], checkpoints: parts.checkpoints ?? [] });
  const woken = (createdAt: string) =>
    new Checkpoint({
      id: CheckpointId.make("idle-1"),
      taskId: RELEASE.id,
      attemptId: null,
      source: "automatic",
      kind: "finding",
      milestoneId: null,
      summary: IDLE_QUEST,
      createdAt,
      revision: 2,
    });
  const later = "2026-11-03T00:05:00.000Z";
  const milestone: LedgerEntry = {
    _tag: "Milestone",
    milestone: new Milestone({
      id: MilestoneId.make("m"),
      taskId: RELEASE.id,
      title: "Shipped",
      position: 0,
      reachedAt: null,
      createdAt: at,
    }),
  };

  // covers OR-004, IN-004
  it("[TC-OR-641] wakes its lead once with a finding that says what is missing, even with its own milestones open", () => {
    const found = idleQuestOf(RELEASE, idleTree(), [milestone], new Set(), at);
    expect(found).toMatchObject({
      _tag: "Wake",
      finding: { taskId: RELEASE.id, source: "automatic", kind: "finding", summary: IDLE_QUEST, createdAt: at },
    });
    const detail = found?._tag === "Wake" ? found.finding.detail : null;
    expect(detail).toContain("Quest q-release (Review the release)");
    expect(detail).toContain("delegate_task");
    expect(detail).toContain("complete_task");
    // Its own steps, all done, moved it on before: it is idle again once they have ended.
    const step = new Task({ ...task("step", FRODO, "release"), state: "completed" });
    expect(idleQuestOf(RELEASE, idleTree({ tasks: [RELEASE, step] }), [], new Set(), at)?._tag).toBe("Wake");
  });

  // covers OR-004, EX-002
  it("[TC-OR-642] stalls the Quest when its lead was woken and its next turn still left nothing moving it", () => {
    const stalled = idleQuestOf(RELEASE, idleTree({ checkpoints: [woken(at)] }), [], new Set(), later);
    expect(stalled).toMatchObject({ _tag: "Stalled", reason: expect.stringContaining("The Quest stalled") });
    // A wake from before its lead last brought work in is about work since done: it wakes again.
    const since = new Task({ ...task("commit", NETTLE, "release"), state: "completed", createdAt: later });
    expect(
      idleQuestOf(RELEASE, idleTree({ tasks: [RELEASE, since], checkpoints: [woken(at)] }), [], new Set(), later)?._tag,
    ).toBe("Wake");
  });

  const open = new Task({ ...task("commit", NETTLE, "release") });
  const item = (id: string): LedgerEntry => ({
    _tag: "Item",
    item: { id: BackpackItemId.make(id) } as BackpackItem,
  });
  // covers OR-004
  it.each([
    ["a Task under it is open", RELEASE, [{ _tag: "Child", task: open } as LedgerEntry], new Set<string>()],
    [
      "a wait holds",
      RELEASE,
      [{ _tag: "Wait", wait: new TaskWait({ taskId: RELEASE.id, on: [open.id], mode: "all", createdAt: at }) }],
      new Set<string>(),
    ],
    ["backpack work waits that the turn did not carry", RELEASE, [item("n1")], new Set(["n2"])],
    ["the Task is a member's", REVIEW, [], new Set<string>()],
    ["the Task is already blocked", new Task({ ...RELEASE, state: "blocked" }), [], new Set<string>()],
    ["the Task is being cancelled", new Task({ ...RELEASE, state: "cancelling" }), [], new Set<string>()],
  ] as const)("[TC-OR-643] does nothing when %s", (_, subject, ledger, carried) => {
    expect(idleQuestOf(subject, idleTree(), ledger, carried, at)).toBeNull();
  });

  // covers OR-004
  it("[TC-OR-644] does nothing for a Task you asked for that leads no active Quest, and counts carried work as settled", () => {
    expect(idleQuestOf(RELEASE, tree({ tasks: [RELEASE], quests: [] }), [], new Set(), at)).toBeNull();
    expect(
      idleQuestOf(
        RELEASE,
        tree({ tasks: [RELEASE], quests: [quest(RELEASE.id, FRODO, "completed")] }),
        [],
        new Set(),
        at,
      ),
    ).toBeNull();
    expect(idleQuestOf(RELEASE, idleTree(), [item("n1")], new Set(["n1"]), at)?._tag).toBe("Wake");
  });
});
