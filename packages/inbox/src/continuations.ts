import type { BackpackItem, Task, ThreadId } from "@hobbots/domain";
import { heldUnder } from "./dispatcher.ts";

/**
 * The thread whose chat a backpack item continues (ADR 019), or null when it goes to another
 * session or wakes nobody. An item goes to the session that owns the Task its recipient holds it
 * under: for the Task you asked for, that is its thread, where its owner chats with you. A Task's
 * own item, and anything held under a step or a member's Task, goes to the session that works that
 * Task instead. Routine progress never wakes a hob (IN-005). An item outside any Task goes to its
 * thread. An item whose Task has ended still routes there, so the dispatcher can settle it as late.
 */
export const continuationThread = (item: BackpackItem, tree: ReadonlyArray<Task>): ThreadId | null => {
  if (!item.actionable) return null;
  if (item.taskId === null) return item.threadId;
  const held = heldUnder(item, tree);
  return held !== undefined && held.parentId === null ? held.threadId : null;
};

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";

const about = (task: Task) => `Task ${task.id} (${firstLine(task.brief)})`;

/** One item, as the continuation's prompt lists it: what arrived, and from where. */
const describeArrival = (item: BackpackItem): string => {
  const payload = item.payload;
  switch (payload._tag) {
    case "result": {
      const made = payload.artifacts.map((artifact) => artifact.label);
      const artifacts = made.length === 0 ? "" : ` It made: ${made.join(", ")}.`;
      return `${about(payload.task)} finished. Its result: ${payload.task.result?.summary ?? "none given"}.${artifacts}`;
    }
    case "failure":
      return `${about(payload.task)} ended as ${payload.task.state}.`;
    case "checkpoint":
      return `A ${payload.checkpoint.kind} was reported on Task ${payload.checkpoint.taskId}: ${payload.checkpoint.summary}`;
    case "question":
      return `Question ${payload.question.id} about Task ${payload.question.taskId} waits for your answer: "${payload.question.text}"`;
    case "answer":
      return `Your question ${payload.question.id} was answered: "${payload.question.answer ?? ""}"`;
    case "hand-off":
      return `"${payload.artifact.label}" was handed to Task ${payload.handOff.toTaskId}: ${payload.artifact.value}`;
    case "message":
      return payload.senderId === null
        ? `The user left a note: ${payload.text}`
        : `Hob ${payload.senderId} sent you a message: ${payload.text}`;
    case "approval-outcome":
      return `The approval you asked for, "${payload.approval.label}", ended as ${payload.approval.state}. ${
        payload.approval.state === "approved" ? "" : "That tool call never ran."
      }`.trim();
    case "deadline":
      return `The deadline on Task ${payload.taskId} passed at ${payload.dueAt}.`;
    case "task":
      return `${about(payload.task)} is yours to work on.`;
    case "progress":
      return `Progress on Task ${payload.checkpoint.taskId}: ${payload.checkpoint.summary}`;
  }
};

/**
 * What a turn that carries backpack items is told (ADR 019). Hobbots writes it and says so, so the
 * hob never takes it for a message from you. As a continuation's prompt it asks the hob to act;
 * riding along a message of yours, it is context only, and your message comes first.
 */
export const arrivalsText = (items: ReadonlyArray<BackpackItem>, as: "prompt" | "context"): string =>
  [
    as === "prompt"
      ? "Hobbots wrote this, not the user. Work arrived for you while you were not running:"
      : "Hobbots adds this, not the user. Work also arrived for you since your last turn:",
    "",
    ...items.map((item) => `- ${describeArrival(item)}`),
    "",
    as === "prompt"
      ? "Act on it now. When the Task you work on in this conversation is done, return its result with complete_task. Tell the user briefly what changed."
      : "Answer the user's message first, then act on this work.",
  ].join("\n");
