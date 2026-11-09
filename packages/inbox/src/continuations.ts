import {
  answerHow,
  type BackpackItem,
  CONTINUATION_HEADER,
  checkpointText,
  choicesText,
  hobProposalOutcomeText,
  type Question,
  skillProposalText,
  type Task,
  type ThreadId,
} from "@hobbots/domain";
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
 * The member's Task whose session carries a backpack item (ADR 019), or undefined when it goes to a
 * thread: an item its recipient holds under a Task another hob gave it, such as the Task itself, a
 * hand-off, an answer, a result of its own steps, or progress from a member it leads in a nested
 * Quest. Items held under a step go to the step's own session, which starts from its brief.
 */
export const carryingTask = (item: BackpackItem, tree: ReadonlyArray<Task>): Task | undefined => {
  if (item.taskId === null) return undefined;
  const held = heldUnder(item, tree);
  const parent = held === undefined ? undefined : tree.find((each) => each.id === held.parentId);
  return held !== undefined && parent !== undefined && parent.ownerId !== held.ownerId ? held : undefined;
};

/**
 * The member's Task whose session a backpack item continues: its carrying Task, for an actionable
 * item. Routine progress never wakes a hob (IN-005); it rides along that session's next turn instead.
 */
export const continuationTask = (item: BackpackItem, tree: ReadonlyArray<Task>): Task | undefined =>
  item.actionable ? carryingTask(item, tree) : undefined;

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";

const about = (task: Task) => `Task ${task.id} (${firstLine(task.brief)})`;

/**
 * How a turn is told the results that arrive with it: `inline` in what arrived, or `briefed` when
 * its Task briefing lists them, as a lead's chat turn's does (#1040).
 */
export type ResultsIn = "inline" | "briefed";

/** Where a lead's chat turn finds a result that arrived for it (#1040). */
export const RESULT_IN_BRIEFING =
  "Its result is under that Task in your briefing, this turn's or the one that listed it first; read_tasks shows it whole.";

/**
 * A result, with what its Task made. A turn whose briefing lists it is pointed there, so the result
 * reaches its session once: in that briefing, or in the earlier one that listed it first (#1040).
 */
const describeResult = (task: Task, artifacts: ReadonlyArray<{ readonly label: string }>, results: ResultsIn) => {
  const made = artifacts.length === 0 ? "" : ` It made: ${artifacts.map((artifact) => artifact.label).join(", ")}.`;
  return results === "briefed"
    ? `${about(task)} finished.${made} ${RESULT_IN_BRIEFING}`
    : `${about(task)} finished. Its result: ${task.result?.summary ?? "none given"}.${made}`;
};

/** An approval's outcome, and whether its call ran. */
const describeApproval = (approval: { readonly label: string; readonly state: string }) =>
  `The approval you asked for, "${approval.label}", ended as ${approval.state}.${
    approval.state === "approved" ? "" : " That tool call never ran."
  }`;

/**
 * Where the user's deliverable goes is the user's to decide (#1215): a lead that picked another
 * place for a file its member could not write let the Quest read done somewhere no one agreed to.
 */
const DESTINATION_RULE =
  "Where the user asked for the work to go is theirs to change: a question about putting it anywhere else, because it cannot go where they asked, is never yours to answer. Pass it up with escalate.";

/**
 * A member's approvals are the user's to decide (PE-006, #1216): a lead that answered "may I run
 * rm?" let the user read that a lead approved what the policy gave them to decide.
 */
const PERMISSION_RULE =
  "Only the user approves a tool call: answer a question asking permission for one by telling the hob to make the call, and never tell the user a lead approved one.";

/**
 * A question for a lead, with what it can do about it: answer it, or pass it up when only a lead
 * above it, or the user, can decide (ADR 018).
 */
const describeQuestion = (question: Question) =>
  `Hob ${question.askerId} asks, as question ${question.id} about Task ${question.taskId}: "${question.text}"${choicesText(question)} Answer it with answer if you can${question.options.length === 0 ? "" : ", giving a choice's label to pick it"}; if only someone above you can decide, pass it up with escalate. ${DESTINATION_RULE} ${PERMISSION_RULE}`;

/** A message: your note on a Task, or a hob's, with the Task it is about. */
const describeMessage = (
  item: BackpackItem,
  message: { readonly senderId: string | null; readonly text: string; readonly aboutTaskId?: string | undefined },
) => {
  const from = message.senderId === null ? "The user left a note" : `Hob ${message.senderId} sent you a message`;
  const about = message.aboutTaskId ?? item.taskId;
  return `${from}${about === null ? "" : ` about Task ${about}`}: ${message.text}`;
};

/** Who answered a question, as the hob that asked hears it. */
const answeredBy = (question: Question) =>
  question.answeredBy?._tag === "User"
    ? " by the user"
    : question.answeredBy?._tag === "Lead"
      ? ` by hob ${question.answeredBy.agentId}`
      : "";

/**
 * What a hob hears after a lead's answer: it approves no tool call, which the user still decides when
 * the policy asks first (#1216). The user's own answer needs no note.
 */
const leadAnswerNote = (question: Question) =>
  question.answeredBy?._tag === "Lead"
    ? " A lead's answer approves no tool call: when your policy asks first, Hobbots asks the user and the call waits for their decision."
    : "";

/** One item, as the continuation's prompt lists it: what arrived, and from where. */
const describeArrival = (item: BackpackItem, results: ResultsIn): string => {
  const payload = item.payload;
  switch (payload._tag) {
    case "result":
      return describeResult(payload.task, payload.artifacts, results);
    case "failure":
      return `${about(payload.task)} ended as ${payload.task.state}${payload.reason === undefined ? "." : `: ${payload.reason}`}`;
    case "checkpoint":
      return `A ${payload.checkpoint.kind} was reported on Task ${payload.checkpoint.taskId}: ${checkpointText(payload.checkpoint)}`;
    case "question":
      return describeQuestion(payload.question);
    case "answer":
      return `Your question ${payload.question.id} was answered${answeredBy(payload.question)}: "${payload.question.answer ?? ""}"${answerHow(payload.question)}${leadAnswerNote(payload.question)}`;
    case "hand-off":
      return `"${payload.artifact.label}" was handed to Task ${payload.handOff.toTaskId}: ${payload.artifact.value}`;
    case "message":
      return describeMessage(item, payload);
    case "approval-outcome":
      return describeApproval(payload.approval);
    case "hob-proposal":
      return hobProposalOutcomeText(payload.proposal);
    case "deadline":
      return `The deadline on Task ${payload.taskId} passed at ${payload.dueAt}.`;
    case "task":
      return `${about(payload.task)} is yours to work on.`;
    default:
      return describeRoutine(item);
  }
};

/** A routine item, as the digest lists it: a Task's progress, or how a skill proposal ended (ADR 029). */
const describeRoutine = (item: BackpackItem): string =>
  item.payload._tag === "skill-proposal" ? skillProposalText(item.payload.proposal) : (progressDigest([item])[0] ?? "");

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

/**
 * The digest's own section of a turn's text, or nothing when no routine item came: progress folded
 * per Task, then each other routine item, such as how a skill proposal ended (ADR 029), on its own line.
 */
const digestSection = (items: ReadonlyArray<BackpackItem>, alone: boolean): ReadonlyArray<string> => {
  const others = items.filter((item) => item.payload._tag !== "progress");
  const lines = [...progressDigest(items), ...others.map((item) => describeArrival(item, "inline"))];
  if (lines.length === 0) return [];
  const heading = `${alone ? "" : "\n"}Routine progress since your last turn, ${plural(items.length, "update")} in all. It needs no reply:`;
  return [heading, ...lines.map((line) => `- ${line}`)];
};

/**
 * What a turn that carries backpack items is told (ADR 019). Hobbots writes it and says so, so the
 * hob never takes it for a message from you. As a continuation's prompt it asks the hob to act;
 * riding along a message of yours, it is context only, and your message comes first. Routine
 * progress is folded into one digest after the work that needs the hob. A lead's chat turn is
 * pointed to its briefing for each result, which lists it there (#1040).
 */
export const arrivalsText = (
  items: ReadonlyArray<BackpackItem>,
  as: "prompt" | "context",
  results: ResultsIn = "inline",
): string => {
  const work = items.filter((item) => item.actionable);
  const progress = items.filter((item) => !item.actionable);
  return [
    as === "prompt"
      ? `${CONTINUATION_HEADER} Work arrived for you while you were not running:`
      : work.length === 0
        ? "Hobbots adds this, not the user."
        : "Hobbots adds this, not the user. Work also arrived for you since your last turn:",
    "",
    ...work.map((item) => `- ${describeArrival(item, results)}`),
    ...digestSection(progress, work.length === 0),
    "",
    as === "prompt"
      ? "Act on it now. When the Task you work on in this conversation is done, return its result with complete_task and give the finish. Otherwise end your turn without a message, unless a question needs the user."
      : work.length === 0
        ? "Answer the user's message. Use this progress only as context."
        : "Answer the user's message first, then act on this work.",
  ].join("\n");
};

/**
 * What a member's first turn on a Task is told of what else it carries, after its brief: a lead's
 * message, an answer or a hand-off that arrived before its session started, so none of it is
 * consumed unread (#574). The Task's own assignment is the brief itself. Empty when nothing else waits.
 */
export const startingText = (items: ReadonlyArray<BackpackItem>): string => {
  const others = items.filter((item) => item.payload._tag !== "task");
  if (others.length === 0) return "";
  const work = others.filter((item) => item.actionable);
  return [
    "Hobbots wrote this, not the user. This also arrived for you before you started:",
    "",
    ...work.map((item) => `- ${describeArrival(item, "inline")}`),
    ...digestSection(
      others.filter((item) => !item.actionable),
      work.length === 0,
    ),
    "",
    "Take it into account as you work on the Task.",
  ].join("\n");
};
