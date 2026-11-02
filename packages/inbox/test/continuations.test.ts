import {
  AgentId,
  ApprovalId,
  ApprovalRequest,
  BackpackItem,
  BackpackItemId,
  type BackpackItemKind,
  type BackpackPayload,
  MessageId,
  Task,
  TaskId,
  type TaskState,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { arrivalsText, backpackItemsFor, carryingThread, continuationThread, lateness } from "../src/index.ts";

const at = "2026-11-02T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const SAM = AgentId.make("sam");
const threadId = ThreadId.make("shire");

const task = (id: string, ownerId: AgentId, parentId: string | null, state: TaskState = "active") =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    rootId: TaskId.make("quest"),
    threadId,
    brief: `Brief for ${id}`,
    state,
    dependsOn: [],
    result: state === "completed" ? { summary: `${id} done`, attemptId: "a1" as never } : null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

/** Routine progress Sam reports on a Task of his, the `order`th update overall. */
const progressOn = (taskId: string, summary: string, order: number) =>
  new BackpackItem({
    ...item(FRODO, taskId, "progress", {
      _tag: "progress",
      checkpoint: {
        id: `c${order}`,
        taskId: TaskId.make(taskId),
        attemptId: null,
        source: "unplanned",
        kind: "progress",
        milestoneId: null,
        summary,
        createdAt: at,
        revision: 1,
      } as never,
    }),
    id: BackpackItemId.make(`progress-${order}`),
    createdAt: `2026-11-02T00:00:${String(order).padStart(2, "0")}.000Z`,
  });

const item = (recipientId: AgentId, taskId: string | null, kind: BackpackItemKind, payload: BackpackPayload) =>
  new BackpackItem({
    id: BackpackItemId.make(`${kind}-${taskId}`),
    recipientId,
    kind,
    actionable: kind !== "progress",
    priority: 1,
    state: "pending",
    taskId: taskId === null ? null : TaskId.make(taskId),
    questId: null,
    attemptId: null,
    threadId,
    dedupeKey: kind,
    payload,
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    disposition: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const quest = task("quest", FRODO, null);
// Frodo's own step, and Sam's delegated Task under the same request.
const step = task("pass", FRODO, "quest", "completed");
const sams = task("cook", SAM, "quest", "completed");
const tree = [quest, step, sams];

describe("which thread a backpack item continues", () => {
  it("continues the request's thread with a result for the Task you asked for, from a step of its own owner too", () => {
    const fromStep = item(FRODO, "pass", "result", { _tag: "result", task: step, artifacts: [] });
    expect(continuationThread(fromStep, tree)).toBe(threadId);
    // A single hob's step result is checked against the request, which still runs, so it is not late.
    expect(lateness(fromStep, tree)).toBeNull();
    expect(continuationThread(item(FRODO, "cook", "result", { _tag: "result", task: sams, artifacts: [] }), tree)).toBe(
      threadId,
    );
  });

  it("leaves a Task's own item, and work held under a step or a member's Task, to the session that works it", () => {
    const queued = task("next", FRODO, "quest", "queued");
    expect(
      continuationThread(item(FRODO, "next", "task", { _tag: "task", task: queued, delegation: null }), [
        ...tree,
        queued,
      ]),
    ).toBeNull();
    const samsWork = task("stew", SAM, "quest");
    expect(
      continuationThread(item(SAM, "stew", "message", { _tag: "message", senderId: FRODO, text: "Hurry" }), [
        ...tree,
        samsWork,
      ]),
    ).toBeNull();
  });

  it("never wakes a hob for routine progress, and continues the thread of work outside any Task", () => {
    const progress = progressOn("cook", "Stirring", 1);
    expect(continuationThread(progress, tree)).toBeNull();
    // It still rides along the next turn in the lead's thread.
    expect(carryingThread(progress, tree)).toBe(threadId);
    expect(continuationThread(item(FRODO, null, "message", { _tag: "message", senderId: null, text: "Hi" }), [])).toBe(
      threadId,
    );
  });

  // covers IN-005
  it("[TC-IN-070] folds thirty progress updates into one digest, after the work that needs the hob", () => {
    const updates = Array.from({ length: 30 }, (_, index) =>
      progressOn(index % 3 === 0 ? "stew" : "cook", `Step ${index + 1}`, index + 1),
    );
    const failure = item(FRODO, "pass", "failure", { _tag: "failure", task: task("pass", FRODO, "quest", "failed") });
    const prompt = arrivalsText([...[...updates].reverse(), failure], "prompt");
    const lines = prompt.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
      "- Task pass (Brief for pass) ended as failed.",
      "- Task stew sent 10 updates. The latest: Step 28",
      "- Task cook sent 20 updates. The latest: Step 30",
    ]);
    expect(prompt).toContain("Routine progress since your last turn, 30 updates in all. It needs no reply:");

    // Riding along your message alone, it is context the hob needs not act on.
    const context = arrivalsText(updates.slice(0, 1), "context");
    expect(context).toContain("Routine progress since your last turn, 1 update in all.");
    expect(context).toContain("- Task stew sent 1 update. The latest: Step 1");
    expect(context).toContain("Use this progress only as context.");
  });

  it("writes what arrived as Hobbots' own words, as a prompt or as context for your message", () => {
    const result = item(FRODO, "pass", "result", { _tag: "result", task: step, artifacts: [] });
    expect(arrivalsText([result], "prompt")).toContain("Hobbots wrote this, not the user.");
    expect(arrivalsText([result], "prompt")).toContain("Task pass (Brief for pass) finished. Its result: pass done.");
    expect(arrivalsText([result], "context")).toContain("Answer the user's message first");
  });
});

describe("an approval outcome no live turn waits for", () => {
  const expired = new ApprovalRequest({
    id: ApprovalId.make("push"),
    agentId: FRODO,
    threadId,
    messageId: MessageId.make("m1"),
    stepId: "tool-1",
    tool: "Bash",
    operation: "push",
    targets: [],
    arguments: {},
    label: "Running git push",
    reason: "Pushing asks first.",
    actionDigest: "d",
    policyVersion: "r1",
    onceOnly: false,
    state: "expired",
    denyReason: null,
    createdAt: at,
    decidedAt: at,
  });
  const events = [{ _tag: "ApprovalResolved", approval: expired } as const];

  it("goes to the hob that asked, in its thread, only when the change says no turn waits", () => {
    expect(backpackItemsFor(events, { tasks: [], quests: [], toolCall: null })).toEqual([]);
    expect(backpackItemsFor(events, { tasks: [], quests: [], toolCall: null, approvalOutcomes: true })).toEqual([
      {
        recipientId: FRODO,
        taskId: null,
        questId: null,
        attemptId: null,
        threadId,
        dedupeKey: "approval:push:approval-outcome",
        payload: { _tag: "approval-outcome", approval: expired },
        notBefore: null,
      },
    ]);
  });
});
