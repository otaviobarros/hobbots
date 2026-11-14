import {
  AgentId,
  type Attempt,
  type AttemptId,
  answerHow,
  type BackpackItem,
  type BackpackPayload,
  checkpointText,
  choicesText,
  claimClashText,
  claimsTakenText,
  type EventEnvelope,
  type HobProposal,
  isLiveAttempt,
  isTerminalTask,
  MEMORY_SAVE_TOOL,
  type MemoryActor,
  type MemoryCaptureItem,
  type MemoryExpected,
  type MemorySave,
  type MemorySessionId,
  MemoryUnavailable,
  type Message,
  type MessageId,
  type MessageStatus,
  type Question,
  type ReplyStep,
  type ReplyStepState,
  skillProposalText,
  type Task,
  type TaskId,
  type ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, Duration, Effect, Layer, Option, Schedule } from "effect";
import {
  type MemoryCaptureExclusions,
  MemoryCaptureLog,
  type MemoryCapturePrivacy,
  type MemoryCaptureSession,
  type MemoryCaptureState,
  type MemoryCaptureWork,
  MemorySaves,
  type MemorySessionRef,
  MemoryStore,
} from "./memory.ts";
import { EventPublisher } from "./ports.ts";
import { makeRedactor, type Redactor, SecretRedaction } from "./secrets.ts";

/**
 * Memory capture (ADR 028, Capture and summaries, When memory is down). The event journal is the
 * outbox: the worker reads it after its cursor and sends what happened in each thread to that
 * thread's session in each hob's own memory (ADR 039, Memory in a shared thread): a hob's replies and
 * their tool steps, the person's messages it took a turn on, with the person as their source, and the
 * Quests it led. Another hob's replies are never sent to a hob's memory, nor a person's message no turn
 * of its took. What a hob did on a Task outside any chat, as a party member or in a
 * step (the Task's goal, its finished tool steps and each turn's reply), to its Attempt's session in
 * that hob's memory (#1012). The work that wakes a hob, such as an answer to its question, goes to
 * the session of the turn that took it in, either one (#1028). It moves the cursor once memory
 * acknowledged all of it. A session quiet for 30 minutes, or whose thread was archived or whose Task
 * ended, is ended, so memory writes its summary page; no runtime turn is spent on it. The same worker
 * sends the `memory_save` calls memory could not take at once. While memory does not answer, nothing
 * moves and nothing is lost: journal compaction keeps every entry after the cursor. A private camp's
 * entries, and its Quest's work outside any chat, are never sent (ADR 037), even once it is public
 * again: the worker follows each camp's privacy along the journal, keeps out for good every message,
 * Attempt and item that had an entry there, and moves the cursor past them.
 */

/** How long a session is quiet before it ends. */
export const MEMORY_SESSION_QUIET = Duration.minutes(30);
/** How long ai-memory skips a key it has seen. An entry sent again after that may be repeated in memory. */
export const MEMORY_KEY_WINDOW = Duration.days(30);
/** How long a save may stay `sending` before the worker takes it as one a stopped hub never finished. */
const SENDING_STALE = Duration.minutes(2);
/** How many journal entries one round reads at a time. */
const PAGE = 200;
/** The longest text one item carries; memory keeps an excerpt of it anyway. */
const TEXT_MAX = 8_000;

const ENDED_REPLY: ReadonlySet<MessageStatus> = new Set(["complete", "failed", "stopped", "interrupted", "limited"]);
const ENDED_STEP: ReadonlySet<ReplyStepState> = new Set(["done", "failed", "denied", "uncertain", "stopped"]);

/** A save a newer write or save of its page replaced before it reached memory: refused, as a conflict is. */
const SUPERSEDED = { state: "refused", version: null } as const;

const sameTags = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

const cut = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text);

/** A tool step in words: its tool, what it did and how it ended, then why or what it printed. */
const stepText = (step: ReplyStep): string => {
  const head = `${step.call?.tool ?? "Tool"}: ${step.label} (${step.state})`;
  const detail = [
    step.reason,
    step.output === undefined
      ? undefined
      : [step.output.head, step.output.tail].filter((part) => part !== "").join("\n…\n"),
  ].filter((part): part is string => part !== undefined && part.trim() !== "");
  return [head, ...detail].join("\n");
};

/** A finished tool step as an item, at the time it ran: its reply ends, and is journaled, later. */
const stepItem = (key: string, step: ReplyStep): MemoryCaptureItem => ({
  key,
  kind: "tool",
  text: stepText(step),
  ...(step.startedAt === undefined ? {} : { at: step.startedAt }),
});

/** What a reply that ended adds to its thread's session: its tool steps, then its text. */
const replyItems = (entry: EventEnvelope, message: Message): Array<MemoryCaptureItem> => {
  if (!ENDED_REPLY.has(message.status)) return [];
  const steps = message.steps
    .filter((step) => step.kind === "tool" && ENDED_STEP.has(step.state))
    // A step keeps its key when Continue resumes its reply, so memory skips it the second time.
    .map((step) => stepItem(`step:${message.id}:${step.id}`, step));
  const text = message.content.trim() === "" ? (message.error ?? "") : message.content;
  return text.trim() === "" ? steps : [...steps, { key: `entry:${entry.id}`, kind: "reply", text }];
};

/** What one journal entry adds to a memory session, a thread's or an Attempt's, in its hob's memory. */
export interface CapturedEntry {
  readonly sessionId: MemorySessionId;
  /**
   * The hob whose memory the session is in. Null for an entry that only ends the thread's session in
   * every hob's memory, as an archive does: a thread with several hobs has a session in each one's.
   */
  readonly agentId: AgentId | null;
  /**
   * What starts the session when it is not open: its start, and for an Attempt its Task's goal once
   * it is known. Null for an entry that only adds to a session already open, as an archive does.
   */
  readonly opening: ReadonlyArray<MemoryCaptureItem> | null;
  readonly items: ReadonlyArray<MemoryCaptureItem>;
  /** The session ends: its thread was archived or made a private camp, or its Task ended. */
  readonly ends: boolean;
}

const threadStart = (threadId: ThreadId): MemoryCaptureItem => ({
  key: `start:${threadId}`,
  kind: "start",
  text: `thread:${threadId}`,
});

/** An Attempt's session start, tagged with the Attempt, its Task and the thread its Quest started in. */
const attemptStart = (attemptId: AttemptId, taskId: TaskId, threadId: ThreadId | null): MemoryCaptureItem => ({
  key: `start:${attemptId}`,
  kind: "start",
  text: [`attempt:${attemptId}`, `task:${taskId}`, ...(threadId === null ? [] : [`thread:${threadId}`])].join("\n"),
});

/** What starts an Attempt's session: its start, then the Task's goal, as the prompt the hob worked on. */
const attemptOpening = (task: Task, attempt: Attempt, redacted: Redacting): Array<MemoryCaptureItem> => [
  attemptStart(attempt.id, task.id, task.threadId),
  ...redacted([{ key: `goal:${attempt.id}`, kind: "message", text: task.brief }]),
];

type Redacting = (items: ReadonlyArray<MemoryCaptureItem>) => Array<MemoryCaptureItem>;

const firstLine = (text: string) => text.split("\n", 1)[0]?.trim() ?? "";
const whoAnswered = (question: Question) =>
  question.answeredBy?._tag === "User"
    ? " by the user"
    : question.answeredBy?._tag === "Lead"
      ? ` by hob ${question.answeredBy.agentId}`
      : "";

/** A Task's result, its summary first. */
const resultText = (task: Task, artifacts: ReadonlyArray<{ readonly label: string }>) => {
  const made = artifacts.length === 0 ? "" : ` It made: ${artifacts.map((artifact) => artifact.label).join(", ")}.`;
  return `Task "${firstLine(task.brief)}" finished: ${task.result?.summary ?? "no result given"}.${made} (Task ${task.id})`;
};

/**
 * What arrived for a hob, as its memory keeps it (#1028): the work in plain words, what it says
 * first, since a summary without a model keeps only a line's start, and without the instructions
 * Hobbots gives the turn around it.
 */
const arrivalText = (payload: Exclude<BackpackPayload, { readonly _tag: "task" | "progress" }>): string => {
  switch (payload._tag) {
    case "result":
      return resultText(payload.task, payload.artifacts);
    case "failure":
      return `Task "${firstLine(payload.task.brief)}" ended as ${payload.task.state}${payload.reason === undefined ? "" : `: ${payload.reason}`}. (Task ${payload.task.id})`;
    case "checkpoint":
      return `${checkpointText(payload.checkpoint)} (a ${payload.checkpoint.kind} on Task ${payload.checkpoint.taskId})`;
    case "question":
      return `Question: "${payload.question.text}"${choicesText(payload.question)} (asked by hob ${payload.question.askerId} as ${payload.question.id}, about Task ${payload.question.taskId})`;
    case "answer":
      return `Answer: "${payload.question.answer ?? ""}"${answerHow(payload.question)}, to the question "${payload.question.text}", answered${whoAnswered(payload.question)} (${payload.question.id})`;
    case "hand-off":
      return `Handed over, "${payload.artifact.label}": ${payload.artifact.value} (to Task ${payload.handOff.toTaskId})`;
    case "message":
      return `${payload.senderId === null ? "Note from the user" : "Message"}: ${payload.text}${payload.senderId === null ? "" : ` (from hob ${payload.senderId})`}`;
    case "approval-outcome":
      return `Approval ${payload.approval.state}: "${payload.approval.label}"`;
    case "deadline":
      return `Deadline passed at ${payload.dueAt} (Task ${payload.taskId})`;
    default:
      return hubArrivalText(payload);
  }
};

/** What the hub itself sent a hob, as its memory keeps it: how a proposal ended, a clash of claims (ADR 037), or your takeover (#1449). */
const hubArrivalText = (
  payload: Extract<
    BackpackPayload,
    { readonly _tag: "skill-proposal" | "hob-proposal" | "claim-clash" | "claims-taken" }
  >,
): string => {
  switch (payload._tag) {
    case "skill-proposal":
      return skillProposalText(payload.proposal);
    case "claim-clash":
      return claimClashText(payload.claim, payload.clashes);
    case "claims-taken":
      return claimsTakenText(payload.taskId, payload.claims);
    default:
      return hobProposalText(payload.proposal);
  }
};

/** A hob proposal the user decided (ADR 034), as the manager's memory keeps it. */
const hobProposalText = (proposal: HobProposal) =>
  `Your proposal on ${proposal.rows.map((row) => row.label).join(", ")} was decided (${proposal.id})`;

/**
 * What a backpack item adds once the runtime accepted the turn it was put into (#1028): the work, to
 * that turn's session in its recipient's memory, a thread's or a member's Attempt's, as a prompt.
 * Kept by the item's own id, so a redelivery or a retry of the turn writes it once.
 */
const arrivalOf = (
  event: Extract<EventEnvelope["payload"], { readonly _tag: "BackpackItemChanged" }>,
  redacted: Redacting,
): CapturedEntry | null => {
  const { item } = event;
  const delivery = item.deliveries.at(-1);
  if (item.state !== "acknowledged" || delivery === undefined) return null;
  // A Task's own assignment is its goal already, and routine progress is never kept (IN-005).
  const { payload } = item;
  if (payload._tag === "task" || payload._tag === "progress") return null;
  const text = arrivalText(payload);
  if (text.trim() === "") return null;
  const items = redacted([{ key: `arrival:${item.id}`, kind: "message", text }]);
  const [target, id] = splitTarget(delivery.target);
  if (target === "thread") {
    const threadId = id as ThreadId;
    return { sessionId: threadId, agentId: item.recipientId, opening: [threadStart(threadId)], items, ends: false };
  }
  if (target === "task") {
    const attemptId = delivery.turnId as AttemptId;
    const opening = [attemptStart(attemptId, id as TaskId, item.threadId)];
    return { sessionId: attemptId, agentId: item.recipientId, opening, items, ends: false };
  }
  return null;
};

/** A delivery's target, `thread:<id>` or `task:<id>`, as its kind and id. */
const splitTarget = (target: string): readonly [string, string] => {
  const at = target.indexOf(":");
  return at < 0 ? [target, ""] : [target.slice(0, at), target.slice(at + 1)];
};

/**
 * What a Task's change adds to its Attempt's session (#1012). Only a Task below the top one works
 * outside any chat, a party member's or a step's: the top Task's turns are its thread's. A live
 * Attempt opens its session, a turn's reply goes into it when the Attempt ends, and the session ends
 * with its Task, whose current Attempt it is.
 */
const taskChangeOf = (
  entry: EventEnvelope,
  event: Extract<EventEnvelope["payload"], { readonly _tag: "TaskStateChanged" }>,
  redacted: Redacting,
): CapturedEntry | null => {
  const { task, attempt } = event;
  if (task.parentId === null) return null;
  if (attempt === null || attempt.taskId !== task.id) {
    // A Task that ended with no Attempt of its own running, as on a cancel or a failure after its turn.
    return isTerminalTask(task.state) && task.currentAttemptId !== null
      ? { sessionId: task.currentAttemptId, agentId: task.ownerId, opening: null, items: [], ends: true }
      : null;
  }
  const reply = event.reply?.trim() ?? "";
  const items = reply === "" ? [] : redacted([{ key: `entry:${entry.id}`, kind: "reply", text: reply }]);
  const live = isLiveAttempt(attempt.state);
  return {
    sessionId: attempt.id,
    agentId: attempt.agentId,
    opening: live || items.length > 0 ? attemptOpening(task, attempt, redacted) : null,
    items,
    ends: !live && isTerminalTask(task.state),
  };
};

/**
 * What an Attempt's steps add to its session. Every change carries all the Attempt's steps: each
 * finished one is kept once, by its own id. Steps only run in an Attempt outside any chat. One that
 * finishes after its session ended for quiet opens it again, by the same start: the goal it was sent
 * first is already there.
 */
const attemptStepsOf = (
  entry: EventEnvelope,
  event: Extract<EventEnvelope["payload"], { readonly _tag: "AttemptStepsRecorded" }>,
  redacted: Redacting,
): CapturedEntry | null => {
  const agentId = entry.correlation.agentId;
  if (agentId === null) return null;
  const steps = event.steps
    .filter((step) => step.kind === "tool" && ENDED_STEP.has(step.state))
    .map((step) => stepItem(`step:${event.attemptId}:${step.id}`, step));
  return steps.length === 0
    ? null
    : {
        sessionId: event.attemptId,
        agentId,
        opening: [attemptStart(event.attemptId, event.taskId, entry.correlation.threadId)],
        items: redacted(steps),
        ends: false,
      };
};

/** The people's messages hobs took a turn on, by id, as capture reads them with the replies to them. */
export type CapturedPrompts = ReadonlyMap<MessageId, Message>;

/** The hob that wrote a reply: its author, or the thread's hob for a reply stored before authors were. */
const replyHob = (entry: EventEnvelope, message: Message): AgentId | null =>
  message.actor?.kind === "hob" ? AgentId.make(message.actor.id) : entry.correlation.agentId;

/** A person's message as a hob's memory keeps it: its text, then who wrote it (ADR 039). */
const promptText = (prompt: Message): string =>
  prompt.actor === null ? prompt.content : `${prompt.content}\n\n(from ${prompt.actor.kind} ${prompt.actor.id})`;

/**
 * The person's message a reply's turn took (its prompt), as the replying hob's memory keeps it, by the
 * message's own id: a second turn on it, as Continue runs, sends nothing new. A note to self is yours
 * alone, and never reaches a hob's memory (ADR 037).
 */
const promptItems = (reply: Message, prompts: CapturedPrompts): Array<MemoryCaptureItem> => {
  const prompt = reply.promptId === null ? undefined : prompts.get(reply.promptId);
  if (prompt === undefined || prompt.role !== "user" || prompt.content.trim() === "") return [];
  return [{ key: `message:${prompt.id}`, kind: "message", text: promptText(prompt), at: prompt.createdAt }];
};

/**
 * What a message adds to its thread's session in its hob's memory: a reply once its turn ends, after
 * the person's message the turn took (ADR 039, Memory in a shared thread). A person's message adds
 * nothing by itself: only the hobs that take a turn on it keep it, each in its own memory.
 */
const messageOf = (
  entry: EventEnvelope,
  message: Message,
  redacted: Redacting,
  prompts: CapturedPrompts,
): CapturedEntry | null => {
  if (message.role !== "assistant") return null;
  const agentId = replyHob(entry, message);
  const reply = replyItems(entry, message);
  if (agentId === null || reply.length === 0) return null;
  const items = [...promptItems(message, prompts), ...reply];
  return items.length === 0
    ? null
    : {
        sessionId: message.threadId,
        agentId,
        opening: [threadStart(message.threadId)],
        items: redacted(items),
        ends: false,
      };
};

/** The Task a save made outside any chat keys its call under (`task:<id>`), or null for one made in a chat. */
const saveTaskOf = (save: MemorySave): TaskId | null =>
  save.work.startsWith("task:") ? (save.work.slice("task:".length) as TaskId) : null;

/** What a save that settled tells its session: that memory has the page now, or that it does not. */
const settledSaveText = (save: MemorySave): string =>
  save.state === "saved"
    ? `${MEMORY_SAVE_TOOL}: ${save.path} is saved in memory${save.version === null ? "" : ` (version ${save.version})`}.`
    : `${MEMORY_SAVE_TOOL}: ${save.path} was not saved. Memory holds a newer write of the page, or would not take this one.`;

/**
 * What a `memory_save` that settled adds to the session of the turn that made it (#1049): whether
 * memory has the page. A save memory could not take at once is kept and sent later, after its reply
 * told the hob so, and only this item tells the session page it landed. A save outside any chat goes
 * to the Attempt it was made in, as its tool step did, even when a retry moved its Task on since.
 * Kept by the save's own id, so it is written once; an Undo of it later adds nothing.
 */
const settledSaveOf = (
  event: Extract<EventEnvelope["payload"], { readonly _tag: "MemorySaveChanged" }>,
  redacted: Redacting,
): CapturedEntry | null => {
  const { save } = event;
  if ((save.state !== "saved" && save.state !== "refused") || save.undoneAt !== undefined) return null;
  const items = redacted([{ key: `save:${save.id}`, kind: "tool", text: settledSaveText(save) }]);
  if (save.threadId !== null) {
    return {
      sessionId: save.threadId,
      agentId: save.agentId,
      opening: [threadStart(save.threadId)],
      items,
      ends: false,
    };
  }
  const taskId = saveTaskOf(save);
  const { attemptId } = save;
  if (taskId === null || attemptId === undefined) return null;
  return {
    sessionId: attemptId,
    agentId: save.agentId,
    opening: [attemptStart(attemptId, taskId, null)],
    items,
    ends: false,
  };
};

/**
 * What memory keeps of a journal entry, redacted by `redactor`, or null for an entry it keeps
 * nothing of. A message of yours is kept once it is no longer queued, by its own id, so saving it
 * again sends nothing new; a reply once its turn ends. An Attempt outside any chat keeps its Task's
 * goal, its finished tool steps and each turn's reply. Either keeps the work that woke a turn, and
 * whether a `memory_save` it made landed.
 */
export const capturedEntryOf = (
  entry: EventEnvelope,
  redactor: Redactor,
  prompts: CapturedPrompts = new Map(),
): CapturedEntry | null => {
  const event = entry.payload;
  const redacted: Redacting = (items) => items.map((item) => ({ ...item, text: cut(redactor.text(item.text)) }));
  switch (event._tag) {
    case "MessageUpserted":
      return messageOf(entry, event.message, redacted, prompts);
    case "QuestStarted": {
      // A top Quest started in a thread is led by the thread's hob. A member's own Quest is in its
      // Attempt's session already, by the tool step that started it.
      const { quest } = event;
      if (quest.threadId === null || quest.parentQuestId !== null) return null;
      const text = `quest:${quest.id}\n${quest.goal}`;
      return {
        sessionId: quest.threadId,
        agentId: quest.leadId,
        opening: [threadStart(quest.threadId)],
        items: redacted([{ key: `quest:${quest.id}`, kind: "quest", text }]),
        ends: false,
      };
    }
    case "ThreadUpserted": {
      // Archived, or made a private camp (ADR 037): either ends the session in every hob's memory.
      const { thread } = event;
      return thread.archivedAt === null && !thread.private
        ? null
        : { sessionId: thread.id, agentId: null, opening: null, items: [], ends: true };
    }
    // A chat started fresh ends its sessions; the new chat opens its own with its first reply.
    case "ChatStartedFresh":
      return { sessionId: event.superseded.id, agentId: null, opening: null, items: [], ends: true };
    case "TaskStateChanged":
      return taskChangeOf(entry, event, redacted);
    case "BackpackItemChanged":
      return arrivalOf(event, redacted);
    case "AttemptStepsRecorded":
      return attemptStepsOf(entry, event, redacted);
    case "MemorySaveChanged":
      return settledSaveOf(event, redacted);
    default:
      return null;
  }
};

const hobActor = (agentId: AgentId): MemoryActor => ({ _tag: "Hob", agentId, projects: [] });
const ownScope = (agentId: AgentId) => ({ _tag: "Hob", agentId }) as const;
const endKey = (session: MemoryCaptureSession) => `end:${session.sessionId}:${session.lastKey}`;

/**
 * What names a session among the open ones: its hob and its id, since a thread with several hobs has
 * a session of the same id in each one's memory (ADR 039).
 */
export type SessionKey = string;
export const sessionKeyOf = (session: MemorySessionRef): SessionKey => `${session.agentId}\0${session.sessionId}`;

/** The keys of the items memory acknowledged in each open session, so a page does not send them again. */
export type SentKeys = ReadonlyMap<SessionKey, ReadonlySet<string>>;

/** One session's items in a round, in order, all sent to its hob's own memory. */
interface Group extends MemorySessionRef {
  readonly items: Array<MemoryCaptureItem>;
}

/** A page of the journal, as the worker sends it: each session's items in order, and the sessions it ends. */
interface Round {
  readonly sequence: number;
  readonly groups: ReadonlyMap<SessionKey, Group>;
  readonly sessions: Map<SessionKey, MemoryCaptureSession>;
  readonly touched: Set<SessionKey>;
  readonly ended: Array<MemoryCaptureSession>;
  /** Entries with something to send that were committed longer ago than memory skips a replay. */
  readonly stale: number;
  /** The keys sent to each session it touched, those sent before included. */
  readonly sent: ReadonlyMap<SessionKey, ReadonlySet<string>>;
  /** The camps private as of the page's last entry, and the units the page kept out for the first time. */
  readonly exclusions: MemoryCaptureExclusions;
  /** Every unit kept out as of the page's last entry. */
  readonly excluded: ReadonlyArray<string>;
}

/**
 * Where an entry belongs, to keep a private camp's out of memory (ADR 037): its thread or its Task,
 * and what its items come from (`unit`): a message, an Attempt, a Quest, a backpack item or a save.
 * A unit with any entry written in a private camp is kept out for good, since a later entry carries
 * all of it again, as a reply's text or an Attempt's steps do.
 */
export interface EntryMarks {
  readonly threadId: ThreadId | null;
  readonly taskId: TaskId | null;
  readonly unit: string | null;
}

const attemptUnit = (attemptId: string) => `attempt:${attemptId}`;

/** Where a backpack item belongs: the Attempt it was put into, or the thread. */
const backpackMarks = (item: BackpackItem): EntryMarks => {
  const delivery = item.deliveries.at(-1);
  const [target, id] = delivery === undefined ? ["", ""] : splitTarget(delivery.target);
  if (delivery !== undefined && target === "task") {
    return { threadId: item.threadId, taskId: id as TaskId, unit: attemptUnit(delivery.turnId) };
  }
  const threadId = target === "thread" ? (id as ThreadId) : item.threadId;
  return { threadId, taskId: item.taskId, unit: `arrival:${item.id}` };
};

/** Where a settled save belongs: the Attempt outside any chat it was made in, or itself in its thread. */
const saveMarks = (save: MemorySave): EntryMarks => {
  const taskId = saveTaskOf(save);
  const unit = save.threadId === null && save.attemptId !== undefined ? attemptUnit(save.attemptId) : `save:${save.id}`;
  return { threadId: save.threadId, taskId, unit };
};

/** Where an entry memory may keep something of belongs, or null for one it never keeps anything of. */
export const entryMarksOf = (entry: EventEnvelope): EntryMarks | null => {
  const event = entry.payload;
  switch (event._tag) {
    case "MessageUpserted":
      return { threadId: event.message.threadId, taskId: null, unit: `message:${event.message.id}` };
    case "QuestStarted":
      return { threadId: event.quest.threadId, taskId: null, unit: `quest:${event.quest.id}` };
    case "ThreadUpserted":
    case "CampMade":
      return { threadId: event.thread.id, taskId: null, unit: null };
    case "ChatStartedFresh":
      return { threadId: event.superseded.id, taskId: null, unit: null };
    case "TaskStateChanged": {
      const { task, attempt } = event;
      const attemptId = attempt !== null && attempt.taskId === task.id ? attempt.id : task.currentAttemptId;
      return { threadId: task.threadId, taskId: task.id, unit: attemptId === null ? null : attemptUnit(attemptId) };
    }
    case "AttemptStepsRecorded":
      return { threadId: entry.correlation.threadId, taskId: event.taskId, unit: attemptUnit(event.attemptId) };
    case "BackpackItemChanged":
      return backpackMarks(event.item);
    case "MemorySaveChanged":
      return saveMarks(event.save);
    default:
      return null;
  }
};

/** A page of journal entries: what memory keeps of each, and where each belongs. */
export interface CapturedPage {
  readonly entries: ReadonlyArray<EventEnvelope>;
  readonly found: ReadonlyArray<CapturedEntry | null>;
  readonly marks: ReadonlyArray<EntryMarks | null>;
}

/** The people's messages the replies that end in a page took, to read them for their hobs' memory. */
const promptIdsOf = (entries: ReadonlyArray<EventEnvelope>): ReadonlyArray<MessageId> => {
  const ids = new Set<MessageId>();
  for (const { payload } of entries) {
    if (payload._tag !== "MessageUpserted") continue;
    const { message } = payload;
    if (message.role === "assistant" && message.promptId !== null && ENDED_REPLY.has(message.status)) {
      ids.add(message.promptId);
    }
  }
  return [...ids];
};

/** What memory keeps of each entry of a page, redacted by `redactor`, and where each belongs. */
const capturePage = (
  entries: ReadonlyArray<EventEnvelope>,
  redactor: Redactor,
  prompts: CapturedPrompts,
): CapturedPage => ({
  entries,
  found: entries.map((entry) => capturedEntryOf(entry, redactor, prompts)),
  marks: entries.map(entryMarksOf),
});

/** The threads and Tasks a page's entries belong to, to ask which are private camps. */
const workOfPage = (page: CapturedPage): MemoryCaptureWork => {
  const threadIds = new Set<ThreadId>();
  const taskIds = new Set<TaskId>();
  for (const marks of page.marks) {
    if (marks === null) continue;
    if (marks.threadId !== null) threadIds.add(marks.threadId);
    if (marks.taskId !== null) taskIds.add(marks.taskId);
  }
  return { threadIds, taskIds };
};

/** What capture keeps of private camps where it stands, and what it reads of the page's work now. */
export interface PagePrivacy {
  readonly atCursor: MemoryCaptureExclusions;
  readonly now: MemoryCapturePrivacy;
}

const NO_PRIVACY: PagePrivacy = {
  atCursor: { privateThreads: [], excluded: [] },
  now: { privateNow: new Set(), taskThreads: new Map() },
};

/** The thread an entry belongs to: its own, or its Task's. */
const threadOf = (marks: EntryMarks, now: MemoryCapturePrivacy): ThreadId | null =>
  marks.threadId ?? (marks.taskId === null ? null : (now.taskThreads.get(marks.taskId) ?? null));

/**
 * Follows a camp's privacy along the journal: a camp is made with it (`CampMade`), and every later
 * change of it is a `ThreadUpserted` entry.
 */
const followPrivacy = (entry: EventEnvelope, privateThreads: Set<ThreadId>) => {
  if (entry.payload._tag !== "ThreadUpserted" && entry.payload._tag !== "CampMade") return;
  const { thread } = entry.payload;
  if (thread.private) privateThreads.add(thread.id);
  else privateThreads.delete(thread.id);
};

/**
 * Plans what a page of entries sends, from the sessions open before it and the keys already sent to
 * them. An entry that only ends a session, as an archive does, does nothing when its session is not
 * open; any other entry opens its session again, which memory continues. Each entry goes to its own
 * hob's session only (ADR 039): a thread with several hobs has a session in each one's memory, and an
 * end of the thread's ends them all. Nothing of a private camp is sent (ADR 037): an entry is skipped
 * when its camp was private when it was written, as the journal says, or is private now, and so is
 * every later entry of its unit, and a person's message once its own unit is kept out. A session of
 * it still open from before the camp was made private ends, in every hob's memory, so what memory has
 * of it stays and nothing more is added.
 */
export const planRound = (
  page: CapturedPage,
  open: ReadonlyArray<MemoryCaptureSession>,
  staleBefore: string,
  sent: SentKeys = new Map(),
  privacy: PagePrivacy = NO_PRIVACY,
): Round => {
  const privateThreads = new Set(privacy.atCursor.privateThreads);
  const excluded = new Set(privacy.atCursor.excluded);
  const excludedNow: Array<string> = [];
  /** Whether the entry is a private camp's; one that is keeps its unit out for good. */
  const keepsOut = (marks: EntryMarks | null) => {
    if (marks === null) return false;
    const threadId = threadOf(marks, privacy.now);
    const isPrivate = threadId !== null && (privateThreads.has(threadId) || privacy.now.privateNow.has(threadId));
    if (isPrivate && marks.unit !== null && !excluded.has(marks.unit)) {
      excluded.add(marks.unit);
      excludedNow.push(marks.unit);
    }
    return isPrivate;
  };
  const sessions = new Map(open.map((session) => [sessionKeyOf(session), session]));
  const groups = new Map<SessionKey, Group>();
  const planned = new Map<SessionKey, Set<string>>();
  const touched = new Set<SessionKey>();
  const ending = new Map<SessionKey, MemoryCaptureSession>();
  let stale = 0;
  /** The open sessions `found` names: its hob's, or every hob's session of its id. */
  const openOf = (found: CapturedEntry): Array<readonly [SessionKey, MemoryCaptureSession]> =>
    [...sessions].filter(
      ([, session]) =>
        session.sessionId === found.sessionId && (found.agentId === null || session.agentId === found.agentId),
    );
  /** Adds what `found` brings that its session was not sent yet, and answers whether it brought anything. */
  const add = (entry: EventEnvelope, found: CapturedEntry & MemorySessionRef, key: SessionKey, opened: boolean) => {
    const { sessionId, agentId } = found;
    const keys = planned.get(key) ?? new Set(sent.get(key));
    planned.set(key, keys);
    // A session that goes on later keeps its first start: the opening's keys never change.
    // An item keeps the time it happened, its entry's when it has none of its own, however late it is sent.
    // A person's message kept out, as one written while its camp was private, is never sent with a reply to it.
    const items = [...(opened ? [] : (found.opening ?? [])), ...found.items]
      .filter((item) => !keys.has(item.key) && !excluded.has(item.key))
      .map((item) => (item.at === undefined ? { ...item, at: entry.occurredAt } : item));
    if (items.length === 0) return false;
    if (entry.occurredAt < staleBefore) stale += 1;
    const group = groups.get(key) ?? { sessionId, agentId, items: [] };
    groups.set(key, group);
    for (const item of items) keys.add(item.key);
    group.items.push(...items);
    const last = items.at(-1) as MemoryCaptureItem;
    sessions.set(key, { sessionId, agentId, lastAt: entry.occurredAt, lastKey: last.key });
    return true;
  };
  /** Ends every open session `found` names: a private camp's in every hob's memory, whichever hob's entry it is. */
  const endAll = (found: CapturedEntry) => {
    for (const [key, session] of openOf(found)) ending.set(key, session);
  };
  page.entries.forEach((entry, at) => {
    followPrivacy(entry, privateThreads);
    const marks = page.marks[at] ?? null;
    const isPrivate = keepsOut(marks);
    const found = page.found[at] ?? null;
    if (found === null) return;
    if (isPrivate) {
      endAll({ ...found, agentId: null });
      return;
    }
    if (marks?.unit != null && excluded.has(marks.unit)) return;
    const { agentId } = found;
    if (agentId === null) {
      if (found.ends) endAll(found);
      return;
    }
    const key = sessionKeyOf({ sessionId: found.sessionId, agentId });
    const opened = sessions.has(key);
    if (!opened && found.opening === null) return;
    if (add(entry, { ...found, agentId }, key, opened)) {
      touched.add(key);
      ending.delete(key);
    }
    const session = sessions.get(key);
    if (found.ends && session !== undefined) ending.set(key, session);
  });
  for (const key of ending.keys()) {
    sessions.delete(key);
    touched.delete(key);
  }
  const sequence = page.entries.at(-1)?.sequence ?? 0;
  return {
    sequence,
    groups,
    sessions,
    touched,
    ended: [...ending.values()],
    stale,
    sent: planned,
    exclusions: { privateThreads: [...privateThreads], excluded: excludedNow },
    excluded: [...excluded],
  };
};

export interface MemoryCaptureShape {
  /**
   * One round: sends the saves memory has not taken yet, then the journal after the cursor until it is
   * caught up, then ends the sessions quiet for 30 minutes. Stops early, with nothing lost,
   * when memory does not answer. Answers whether it caught up.
   */
  readonly runOnce: Effect.Effect<boolean>;
}

/** The capture worker. `MemoryCapture.layer` runs it every few seconds for as long as the hub runs. */
export class MemoryCapture extends Context.Service<MemoryCapture, MemoryCaptureShape>()(
  "@hobbots/agents/MemoryCapture",
) {
  /** The worker, without running it on its own: for tests, which call `runOnce`. */
  static readonly make = Layer.effect(
    MemoryCapture,
    Effect.gen(function* () {
      const store = yield* MemoryStore;
      const log = yield* MemoryCaptureLog;
      const saves = yield* Effect.serviceOption(MemorySaves);
      const publisher = yield* Effect.serviceOption(EventPublisher);
      const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
      let state: MemoryCaptureState | null = null;
      // What each open session was sent, so an Attempt's steps, which every change carries again, go
      // once. Kept only in the worker: after a restart memory skips what it has seen by its keys.
      let sent = new Map<SessionKey, ReadonlySet<string>>();
      const now = Effect.map(DateTime.now, DateTime.formatIso);
      const before = (duration: Duration.Duration) =>
        Effect.map(DateTime.now, (at) => DateTime.formatIso(DateTime.subtractDuration(at, duration)));

      /** Tells every client a save settled; a client that misses it reads the save again later. */
      const announce = (entries: ReadonlyArray<EventEnvelope>) =>
        Option.match(publisher, {
          onNone: () => Effect.void,
          onSome: (events) =>
            Effect.ignoreCause(events.publish(entries), { log: "Warn", message: "Could not announce a sent save" }),
        });

      /**
       * Where a save still to send stands against its page as memory holds it now (ADR 028, When
       * memory is down). Memory may have taken it already, from a hub that stopped before settling
       * it: then the page holds it, and nothing is written again. A page written after the save was
       * made, by a later save or by you, is newer, so the older save never replaces it. Otherwise it
       * is written on the version just read, and a write that lands in between wins the same way.
       */
      const resend = (save: MemorySave) =>
        Effect.gen(function* () {
          const actor = hobActor(save.agentId);
          const draft = { path: save.path, markdown: save.markdown, tags: save.tags, pinned: false };
          const page = yield* store.page(actor, save.scope, save.path);
          if (page !== null && page.markdown === draft.markdown && sameTags(page.tags, draft.tags)) {
            return { state: "saved", version: page.version } as const;
          }
          if (page !== null && Date.parse(page.updatedAt) >= Date.parse(save.createdAt)) return SUPERSEDED;
          const expected: MemoryExpected = page === null ? { _tag: "New" } : { _tag: "Version", version: page.version };
          return yield* store.write(actor, save.scope, draft, expected).pipe(
            Effect.map((version) => ({ state: "saved", version }) as const),
            Effect.catchTag("MemoryConflict", () => Effect.succeed(SUPERSEDED)),
          );
        });

      /** The `memory_save` calls memory did not take, or a stopped hub never settled, oldest first. */
      const sendSaves = Effect.gen(function* () {
        if (Option.isNone(saves)) return;
        const staleSending = yield* before(SENDING_STALE);
        const unsent = (yield* saves.value.unsent).filter(
          (save) =>
            save.scope._tag === "Hob" &&
            (save.state === "queued" || (save.state === "sending" && save.updatedAt < staleSending)),
        );
        // A page's newest save replaces its older ones, which are never written: sending them first
        // would stamp the page later than the newest was made.
        const byPage = new Map<string, Array<MemorySave>>();
        for (const save of unsent) {
          const page = `${save.agentId}\0${save.path}`;
          byPage.set(page, [...(byPage.get(page) ?? []), save]);
        }
        for (const pageSaves of byPage.values()) {
          const newest = pageSaves[pageSaves.length - 1] as MemorySave;
          const outcome = yield* resend(newest);
          for (const save of [newest, ...pageSaves.slice(0, -1)]) {
            const settled = save === newest ? outcome : SUPERSEDED;
            const committed = yield* saves.value.settle(save, settled.state, settled.version, yield* now);
            if (Option.isSome(committed)) yield* announce(committed.value.entries);
          }
        }
      });

      const endSession = (session: MemoryCaptureSession) =>
        store.endSession(hobActor(session.agentId), ownScope(session.agentId), session.sessionId, endKey(session));

      /** Sends one page of the journal; answers whether the journal had nothing more. */
      const sendPage = (current: MemoryCaptureState) =>
        Effect.gen(function* () {
          const entries = yield* log.readAfter(current.sequence, PAGE);
          if (entries.length === 0) return true;
          // A message written before capture started is never kept: whether its camp was private then is unknown.
          const read = yield* log.messages(promptIdsOf(entries));
          const prompts = new Map(read.filter((m) => m.createdAt >= current.since).map((m) => [m.id, m] as const));
          const page = capturePage(entries, redactor, prompts);
          const privacy = { atCursor: current.exclusions, now: yield* log.privacy(workOfPage(page)) };
          const round = planRound(page, current.sessions, yield* before(MEMORY_KEY_WINDOW), sent, privacy);
          if (round.stale > 0) {
            yield* Effect.logWarning(
              `Memory capture is sending ${round.stale} journal entries older than memory's 30-day replay window; if any reached memory before, it may keep them twice.`,
            );
          }
          // Each session goes to its own hob's memory, as that hob: never another hob's (ADR 039).
          for (const group of round.groups.values()) {
            const acknowledged = yield* store.capture(
              hobActor(group.agentId),
              ownScope(group.agentId),
              group.sessionId,
              group.items,
            );
            if (acknowledged < group.items.length) {
              return yield* new MemoryUnavailable({ message: "Memory took only part of a session's capture." });
            }
          }
          // An end memory put off, under a chat note you pinned, keeps its session open to send again.
          const waiting: Array<MemoryCaptureSession> = [];
          for (const session of round.ended) if (!(yield* endSession(session))) waiting.push(session);
          for (const session of waiting) round.sessions.set(sessionKeyOf(session), session);
          const active = [
            ...[...round.touched].map((key) => round.sessions.get(key) as MemoryCaptureSession),
            ...waiting,
          ];
          // Saved as soon as memory acknowledged the page: a crash before this sends it once more, and
          // memory skips what it has seen.
          yield* log.save(
            round.sequence,
            active,
            round.ended.filter((session) => !waiting.includes(session)),
            round.exclusions,
          );
          state = {
            sequence: round.sequence,
            since: current.since,
            sessions: [...round.sessions.values()],
            exclusions: { privateThreads: round.exclusions.privateThreads, excluded: round.excluded },
          };
          for (const [key, keys] of round.sent) {
            if (round.sessions.has(key)) sent.set(key, keys);
            else sent.delete(key);
          }
          return entries.length < PAGE;
        });

      /** Ends the sessions quiet for 30 minutes, once the journal is caught up. */
      const endQuiet = (current: MemoryCaptureState) =>
        Effect.gen(function* () {
          const quietBefore = yield* before(MEMORY_SESSION_QUIET);
          const quiet = current.sessions.filter((session) => session.lastAt < quietBefore);
          if (quiet.length === 0) return;
          // An end memory put off stays open, and is sent again at the next round.
          const ended = new Map<SessionKey, MemoryCaptureSession>();
          for (const session of quiet) if (yield* endSession(session)) ended.set(sessionKeyOf(session), session);
          if (ended.size === 0) return;
          yield* log.save(current.sequence, [], [...ended.values()], {
            privateThreads: current.exclusions.privateThreads,
            excluded: [],
          });
          state = { ...current, sessions: current.sessions.filter((session) => !ended.has(sessionKeyOf(session))) };
          for (const key of ended.keys()) sent.delete(key);
        });

      const round = Effect.gen(function* () {
        if (state === null) state = yield* log.hold;
        yield* sendSaves;
        let caughtUp = false;
        while (!caughtUp) caughtUp = yield* sendPage(state);
        yield* endQuiet(state);
        return true;
      });

      return MemoryCapture.of({
        runOnce: round.pipe(
          Effect.catchTag("MemoryUnavailable", () => Effect.succeed(false)),
          // Whatever went wrong, the cursor was not moved past it: the next round reads it again.
          Effect.catchCause((cause) =>
            Effect.logWarning("Memory capture stopped a round", cause).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  state = null;
                  sent = new Map();
                  return false;
                }),
              ),
            ),
          ),
        ),
      });
    }),
  );

  /** The worker, run every few seconds for as long as the layer's scope is open. */
  static readonly layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const capture = yield* MemoryCapture;
      yield* capture.runOnce.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
    }),
  ).pipe(Layer.provideMerge(MemoryCapture.make));

  /** For a hub whose memory is turned off: compaction keeps nothing for capture, and nothing is sent. */
  static readonly off = Layer.effectDiscard(Effect.flatMap(MemoryCaptureLog, (log) => log.release));
}
