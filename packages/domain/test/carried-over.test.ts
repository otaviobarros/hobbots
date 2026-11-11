import { describe, expect, it } from "vitest";
import {
  type AgentId,
  BackpackItem,
  type BackpackItemId,
  CarriedOver,
  carriedOverBriefing,
  carriedOverFrom,
  Question,
  type QuestionId,
  Task,
  type TaskId,
  type ThreadId,
} from "../src/index.ts";

const at = "2026-11-11T00:00:00.000Z";
const chat = "chat-1" as ThreadId;

const task = new Task({
  id: "task-1" as TaskId,
  ownerId: "aldric" as AgentId,
  parentId: null,
  rootId: "task-1" as TaskId,
  threadId: chat,
  brief: "Draft the launch post\nwith the screenshots",
  state: "active",
  dependsOn: [],
  result: null,
  currentAttemptId: null,
  createdAt: at,
  updatedAt: at,
  revision: 1 as Task["revision"],
});

const question = new Question({
  id: "question-1" as QuestionId,
  taskId: task.id,
  askerId: "aldric" as AgentId,
  recipientId: null,
  chain: [],
  text: "Which   screenshots?",
  state: "open",
  answer: null,
  answeredBy: null,
  createdAt: at,
  answeredAt: null,
  revision: 1 as Question["revision"],
});

const item = (id: string, payload: BackpackItem["payload"], taskId: TaskId | null) =>
  new BackpackItem({
    id: id as BackpackItemId,
    recipientId: "aldric" as AgentId,
    kind: payload._tag,
    actionable: true,
    priority: 1,
    state: "pending",
    taskId,
    questId: null,
    attemptId: null,
    threadId: chat,
    dedupeKey: id,
    payload,
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    disposition: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    revision: 1 as BackpackItem["revision"],
  });

describe("carriedOverFrom", () => {
  it("names Tasks, questions, reminders and other items, each once and in that order", () => {
    const deadline = item(
      "deadline-1",
      { _tag: "deadline", taskId: task.id, dueAt: "2026-11-12T09:00:00.000Z" },
      task.id,
    );
    const note = item("note-1", { _tag: "message", senderId: null, text: "Ping" }, null);
    expect(carriedOverFrom({ tasks: [task], trees: [task], questions: [question], items: [deadline, note] })).toEqual([
      { ref: { _tag: "task", taskId: task.id }, label: "Draft the launch post with the screenshots" },
      { ref: { _tag: "question", questionId: question.id }, label: "Which screenshots?" },
      { ref: { _tag: "reminder", itemId: deadline.id }, label: "due 2026-11-12T09:00:00.000Z" },
      { ref: { _tag: "backpack-item", itemId: note.id }, label: "message" },
    ]);
  });

  it("cuts a long label to one line", () => {
    const long = new Task({ ...task, brief: "word ".repeat(100) });
    const [carried] = carriedOverFrom({ tasks: [long], trees: [long], questions: [], items: [] });
    expect(carried?.label.length).toBe(200);
    expect(carried?.label.endsWith("…")).toBe(true);
  });
});

describe("carriedOverBriefing", () => {
  it("is null when nothing was carried, and lists each carried item otherwise", () => {
    expect(carriedOverBriefing([])).toBeNull();
    const carried = new CarriedOver({
      fromThreadId: chat,
      toThreadId: "chat-2" as ThreadId,
      ref: { _tag: "task", taskId: task.id },
      label: "Draft the launch post",
      carriedAt: at,
    });
    expect(carriedOverBriefing([carried])).toContain("- Open work: Draft the launch post (Task task-1)");
  });
});
