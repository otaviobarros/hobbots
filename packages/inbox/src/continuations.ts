import type { BackpackItem, Question, Task, ThreadId } from "@hobbots/domain";
import { heldUnder } from "./dispatcher.ts";

/**
 * The thread whose next turn carries a backpack item (ADR 019), or null when it goes to another
 * session. An item goes to the session that owns the Task its recipient holds it under: for the
 * Task you asked for, that is its thread, where its owner chats with you. A Task's own item, and
 * anything held under a step or a member's Task, goes to the session that works that Task instead.
 * An item outside any Task goes to its thread. An item whose Task has ended still routes there, so
 * the dispatcher can settle it as late.
 */
export const carryingThread = (item: BackpackItem, tree: ReadonlyArray<Task>): ThreadId | null => {
  if (item.taskId === null) return item.threadId;
  const held = heldUnder(item, tree);
  return held !== undefined && held.parentId === null ? held.threadId : null;
};

/**
 * The thread whose chat a backpack item continues: its carrying thread, for an actionable item.
 * Routine progress never wakes a hob (IN-005); it rides along the thread's next turn instead.
 */
export const continuationThread = (item: BackpackItem, tree: ReadonlyArray<Task>): ThreadId | null =>
  item.actionable ? carryingThread(item, tree) : null;

/**
 * The member's Task whose session a backpack item continues (ADR 019), or undefined when it goes to
 * a thread or wakes nobody: an actionable item its recipient holds under a Task another hob gave
 * it, such as the Task itself, a hand-off, an answer or a result of its own steps. Items held
 * under a step go to the step's own session, which starts from its brief.
 */
export const continuationTask = (item: BackpackItem, tree: ReadonlyArray<Task>): Task | undefined => {
  if (!item.actionable || item.taskId === null) return undefined;
  const held = heldUnder(item, tree);
  const parent = held === undefined ? undefined : tree.find((each) => each.id === held.parentId);
  return held !== undefined && parent !== undefined && parent.ownerId !== held.ownerId ? held : undefined;
};

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";

const about = (task: Task) => `Task ${task.id} (${firstLine(task.brief)})`;

/** A result, with what its Task made. */
const describeResult = (task: Task, artifacts: ReadonlyArray<{ readonly label: string }>) => {
  const made = artifacts.length === 0 ? "" : ` It made: ${artifacts.map((artifact) => artifact.label).join(", ")}.`;
  return `${about(task)} finished. Its result: ${task.result?.summary ?? "none given"}.${made}`;
};

/** An approval's outcome, and whether its call ran. */
const describeApproval = (approval: { readonly label: string; readonly state: string }) =>
  `The approval you asked for, "${approval.label}", ended as ${approval.state}.${
    approval.state === "approved" ? "" : " That tool call never ran."
  }`;

/**
 * A question for a lead, with what it can do about it: answer it, or pass it up when only a lead
 * above it, or the user, can decide (ADR 018).
 */
const describeQuestion = (question: Question) =>
  `Hob ${question.askerId} asks, as question ${question.id} about Task ${question.taskId}: "${question.text}" Answer it with answer if you can; if only someone above you can decide, pass it up with escalate.`;

/** A message: your note on a Task, or a hob's, with the Task it is about. */
const describeMessage = (item: BackpackItem, message: { readonly senderId: string | null; readonly text: string }) => {
  const from = message.senderId === null ? "The user left a note" : `Hob ${message.senderId} sent you a message`;
  return `${from}${item.taskId === null ? "" : ` about Task ${item.taskId}`}: ${message.text}`;
};

/** Who answered a question, as the hob that asked hears it. */
const answeredBy = (question: Question) =>
  question.answeredBy?._tag === "User"
    ? " by the user"
    : question.answeredBy?._tag === "Lead"
      ? ` by hob ${question.answeredBy.agentId}`
      : "";

/** One item, as the continuation's prompt lists it: what arrived, and from where. */
const describeArrival = (item: BackpackItem): string => {
  const payload = item.payload;
  switch (payload._tag) {
    case "result":
      return describeResult(payload.task, payload.artifacts);
    case "failure":
      return `${about(payload.task)} ended as ${payload.task.state}.`;
    case "checkpoint":
      return `A ${payload.checkpoint.kind} was reported on Task ${payload.checkpoint.taskId}: ${payload.checkpoint.summary}`;
    case "question":
      return describeQuestion(payload.question);
    case "answer":
      return `Your question ${payload.question.id} was answered${answeredBy(payload.question)}: "${payload.question.answer ?? ""}"`;
    case "hand-off":
      return `"${payload.artifact.label}" was handed to Task ${payload.handOff.toTaskId}: ${payload.artifact.value}`;
    case "message":
      return describeMessage(item, payload);
    case "approval-outcome":
      return describeApproval(payload.approval);
    case "deadline":
      return `The deadline on Task ${payload.taskId} passed at ${payload.dueAt}.`;
    case "task":
      return `${about(payload.task)} is yours to work on.`;
    case "progress":
      return progressDigest([item])[0] ?? "";
  }
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Routine progress folded into one digest (IN-005): a line per Task, in the order the Tasks first
 * reported, with how many updates it sent and the latest of them. Thirty updates read as one
 * summary, not thirty arrivals.
 */
const progressDigest = (items: ReadonlyArray<BackpackItem>): ReadonlyArray<string> => {
  const byTask = new Map<string, { count: number; latest: string }>();
  for (const item of [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (item.payload._tag !== "progress") continue;
    const { taskId, summary } = item.payload.checkpoint;
    byTask.set(taskId, { count: (byTask.get(taskId)?.count ?? 0) + 1, latest: summary });
  }
  return [...byTask].map(
    ([taskId, { count, latest }]) => `Task ${taskId} sent ${plural(count, "update")}. The latest: ${latest}`,
  );
};

/** The digest's own section of a turn's text, or nothing when no progress came. */
const digestSection = (items: ReadonlyArray<BackpackItem>, alone: boolean): ReadonlyArray<string> => {
  const lines = progressDigest(items);
  if (lines.length === 0) return [];
  const heading = `${alone ? "" : "\n"}Routine progress since your last turn, ${plural(items.length, "update")} in all. It needs no reply:`;
  return [heading, ...lines.map((line) => `- ${line}`)];
};

/**
 * What a turn that carries backpack items is told (ADR 019). Hobbots writes it and says so, so the
 * hob never takes it for a message from you. As a continuation's prompt it asks the hob to act;
 * riding along a message of yours, it is context only, and your message comes first. Routine
 * progress is folded into one digest after the work that needs the hob.
 */
export const arrivalsText = (items: ReadonlyArray<BackpackItem>, as: "prompt" | "context"): string => {
  const work = items.filter((item) => item.actionable);
  const progress = items.filter((item) => !item.actionable);
  return [
    as === "prompt"
      ? "Hobbots wrote this, not the user. Work arrived for you while you were not running:"
      : work.length === 0
        ? "Hobbots adds this, not the user."
        : "Hobbots adds this, not the user. Work also arrived for you since your last turn:",
    "",
    ...work.map((item) => `- ${describeArrival(item)}`),
    ...digestSection(progress, work.length === 0),
    "",
    as === "prompt"
      ? "Act on it now. When the Task you work on in this conversation is done, return its result with complete_task. Tell the user briefly what changed."
      : work.length === 0
        ? "Answer the user's message. Use this progress only as context."
        : "Answer the user's message first, then act on this work.",
  ].join("\n");
};
