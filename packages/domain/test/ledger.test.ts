import { describe, expect, it } from "vitest";
import {
  AgentId,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  BackpackItem,
  BackpackItemId,
  carriedFrom,
  HandOff,
  ledgerRefusal,
  Question,
  QuestionId,
  ResponsibilityLedger,
  responsibilityLedger,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  TaskWait,
} from "../src/index.ts";

const at = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");

const task = (id: string, parent: string | null, state: TaskState = "active") =>
  new Task({
    id: TaskId.make(id),
    ownerId: ALDRIC,
    parentId: parent === null ? null : TaskId.make(parent),
    rootId: TaskId.make("top"),
    threadId: null,
    brief: `Brief for ${id}\nMore detail`,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const tree = (tasks: ReadonlyArray<Task>, records: Partial<ConstructorParameters<typeof TaskTree>[0]> = {}) =>
  new TaskTree({
    tasks,
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
    ...records,
  });

const question = (id: string) =>
  new Question({
    id: QuestionId.make(id),
    taskId: TaskId.make("child"),
    askerId: ALDRIC,
    recipientId: null,
    chain: [],
    text: "Which tone?",
    state: "open",
    answer: null,
    answeredBy: null,
    createdAt: at,
    answeredAt: null,
    revision: 1,
  });

const item = (id: string, payload: BackpackItem["payload"], taskId = "child") =>
  new BackpackItem({
    id: BackpackItemId.make(id),
    recipientId: ALDRIC,
    kind: payload._tag,
    actionable: true,
    priority: 1,
    state: "pending",
    taskId: TaskId.make(taskId),
    questId: null,
    attemptId: null,
    threadId: null,
    dedupeKey: id,
    payload,
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    blockers: [],
    disposition: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const wait = (mode: "any" | "all") =>
  new TaskWait({ taskId: TaskId.make("top"), on: [TaskId.make("a"), TaskId.make("b")], mode, createdAt: at });

describe("responsibilityLedger", () => {
  it("holds a wait for any until one ends, and a wait for all until every one has", () => {
    const top = task("top", null);
    const ledger = (a: TaskState, b: TaskState, mode: "any" | "all") =>
      responsibilityLedger(top, {
        subtree: tree([top, task("a", "top", a), task("b", "top", b)], { waits: [wait(mode)] }),
        tree: [],
        approvals: [],
        items: [],
      }).open.filter((entry) => entry._tag === "Wait");
    expect(ledger("completed", "active", "any")).toEqual([]);
    expect(ledger("completed", "active", "all")).toHaveLength(1);
    expect(ledger("completed", "failed", "all")).toEqual([]);
    expect(ledger("active", "active", "any")).toHaveLength(1);
  });

  it("counts a question once, by its record, an ended Task's own item not at all, and only items about the work", () => {
    const top = task("top", null);
    const child = task("child", "top", "completed");
    const done = { _tag: "result" as const, task: child, artifacts: [] };
    const { open } = responsibilityLedger(top, {
      subtree: tree([top, child], { questions: [question("q1")] }),
      tree: [],
      approvals: [],
      items: [
        item("i-question", { _tag: "question", question: question("q1") }),
        // Once a Task under it ended, only its result or failure is left to read.
        item("i-taken", { _tag: "task", task: child, delegation: null }),
        item("i-handed", {
          _tag: "hand-off",
          handOff: new HandOff({ artifactId: ArtifactId.make("art"), toTaskId: child.id, createdAt: at }),
          artifact: new ArtifactRef({
            id: ArtifactId.make("art"),
            taskId: child.id,
            attemptId: AttemptId.make("a1"),
            kind: "text",
            label: "Doc",
            value: "text",
            createdAt: at,
          }),
        }),
        item("i-result", done),
        item("i-elsewhere", done, "elsewhere"),
      ],
    });
    expect(open.map((entry) => entry._tag)).toEqual(["Question", "Item"]);
    expect(open[1]).toMatchObject({ item: { id: "i-result" } });
  });
});

describe("ledgerRefusal", () => {
  it("is null for a settled ledger, and otherwise names what is open with the first entry's reason", () => {
    const child = task("child", "top");
    expect(ledgerRefusal(new ResponsibilityLedger({ taskId: TaskId.make("top"), open: [] }))).toBeNull();
    const open = Array.from({ length: 10 }, (_, index) => ({
      _tag: "Child" as const,
      task: new Task({ ...child, id: TaskId.make(`c${index}`) }),
    }));
    const refusal = ledgerRefusal(new ResponsibilityLedger({ taskId: TaskId.make("top"), open }));
    expect(refusal?.reason).toBe("children-open");
    expect(refusal?.message).toMatch(/^Task top cannot complete yet: Task c0 \(Brief for child\) is active; /);
    expect(refusal?.message).toMatch(/; and 2 more\.$/);
  });

  it("names an unread result by its Task, and a turn that was shown it carries it", () => {
    const child = task("child", "top", "completed");
    const ledger = new ResponsibilityLedger({
      taskId: TaskId.make("top"),
      open: [
        { _tag: "Item", item: item("i-result", { _tag: "result", task: child, artifacts: [] }) },
        { _tag: "Item", item: item("i-failure", { _tag: "failure", task: task("other", "top", "failed") }) },
      ],
    });
    expect(ledgerRefusal(ledger)).toEqual({
      reason: "items-open",
      message:
        "Task top cannot complete yet: the result of Task child (Brief for child) is in your backpack, not yet read; " +
        "Task other (Brief for other) failed, and you have not read it yet.",
    });
    expect(carriedFrom(ledger, (each) => each.kind === "result")).toEqual([
      { itemId: "i-result", owner: null, token: 0 },
    ]);
  });
});
