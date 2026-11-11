import {
  type AgentId,
  type Attempt,
  type AttemptId,
  answerHow,
  type BackpackPayload,
  checkpointText,
  choicesText,
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
  MemoryCaptureLog,
  type MemoryCaptureSession,
  type MemoryCaptureState,
  type MemoryCaptureWork,
  MemorySaves,
  MemoryStore,
} from "./memory.ts";
import { EventPublisher } from "./ports.ts";
import { makeRedactor, type Redactor, SecretRedaction } from "./secrets.ts";

/**
 * Memory capture (ADR 028, Capture and summaries, When memory is down). The event journal is the
 * outbox: the worker reads it after its cursor and sends what happened in each thread (your
 * messages, the hob's replies and their tool steps, and the Quests it led) to that thread's session
 * in its hob's own memory, and what a hob did on a Task outside any chat, as a party member or in a
 * step (the Task's goal, its finished tool steps and each turn's reply), to its Attempt's session in
 * that hob's memory (#1012). The work that wakes a hob, such as an answer to its question, goes to
 * the session of the turn that took it in, either one (#1028). It moves the cursor once memory
 * acknowledged all of it. A session quiet for 30 minutes, or whose thread was archived or whose Task
 * ended, is ended, so memory writes its summary page; no runtime turn is spent on it. The same worker
 * sends the `memory_save` calls memory could not take at once. While memory does not answer, nothing
 * moves and nothing is lost: journal compaction keeps every entry after the cursor. A private camp's
 * entries, and its Quest's work outside any chat, are never sent (ADR 037); the cursor moves past them.
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
  readonly agentId: AgentId;
  /**
   * What starts the session when it is not open: its start, and for an Attempt its Task's goal once
   * it is known. Null for an entry that only adds to a session already open, as an archive does.
   */
  readonly opening: ReadonlyArray<MemoryCaptureItem> | null;
  readonly items: ReadonlyArray<MemoryCaptureItem>;
  /** The session ends: its thread was archived or made a private camp, or its Task ended. */
  readonly ends: boolean;
  /** The thread the entry happened in and the Task it worked on, either known, to tell a private camp's (ADR 037). */
  readonly work: EntryWork;
}

interface EntryWork {
  readonly threadId: ThreadId | null;
  readonly taskId: TaskId | null;
}

const inThread = (threadId: ThreadId | null): EntryWork => ({ threadId, taskId: null });

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
    case "skill-proposal":
      return skillProposalText(payload.proposal);
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
    const work = { threadId, taskId: item.taskId };
    return {
      sessionId: threadId,
      agentId: item.recipientId,
      opening: [threadStart(threadId)],
      items,
      ends: false,
      work,
    };
  }
  if (target === "task") {
    const attemptId = delivery.turnId as AttemptId;
    const taskId = id as TaskId;
    const opening = [attemptStart(attemptId, taskId, item.threadId)];
    const work = { threadId: item.threadId, taskId };
    return { sessionId: attemptId, agentId: item.recipientId, opening, items, ends: false, work };
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
  const work = { threadId: task.threadId, taskId: task.id };
  if (attempt === null || attempt.taskId !== task.id) {
    // A Task that ended with no Attempt of its own running, as on a cancel or a failure after its turn.
    return isTerminalTask(task.state) && task.currentAttemptId !== null
      ? { sessionId: task.currentAttemptId, agentId: task.ownerId, opening: null, items: [], ends: true, work }
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
    work,
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
        work: { threadId: entry.correlation.threadId, taskId: event.taskId },
      };
};

/** What a message adds to its thread's session: yours once it is no longer queued, a reply once its turn ends. */
const messageOf = (entry: EventEnvelope, message: Message, redacted: Redacting): CapturedEntry | null => {
  const agentId = entry.correlation.agentId;
  if (agentId === null) return null;
  const items =
    message.role === "user"
      ? message.status === "complete"
        ? [{ key: `message:${message.id}`, kind: "message" as const, text: message.content }]
        : []
      : replyItems(entry, message);
  return items.length === 0
    ? null
    : {
        sessionId: message.threadId,
        agentId,
        opening: [threadStart(message.threadId)],
        items: redacted(items),
        ends: false,
        work: inThread(message.threadId),
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
      work: inThread(save.threadId),
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
    work: { threadId: null, taskId },
  };
};

/**
 * What memory keeps of a journal entry, redacted by `redactor`, or null for an entry it keeps
 * nothing of. A message of yours is kept once it is no longer queued, by its own id, so saving it
 * again sends nothing new; a reply once its turn ends. An Attempt outside any chat keeps its Task's
 * goal, its finished tool steps and each turn's reply. Either keeps the work that woke a turn, and
 * whether a `memory_save` it made landed.
 */
export const capturedEntryOf = (entry: EventEnvelope, redactor: Redactor): CapturedEntry | null => {
  const event = entry.payload;
  const redacted: Redacting = (items) => items.map((item) => ({ ...item, text: cut(redactor.text(item.text)) }));
  switch (event._tag) {
    case "MessageUpserted":
      return messageOf(entry, event.message, redacted);
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
        work: inThread(quest.threadId),
      };
    }
    case "ThreadUpserted": {
      // Archived, or made a private camp (ADR 037): either ends the session.
      const { thread } = event;
      return thread.archivedAt === null && !thread.private
        ? null
        : {
            sessionId: thread.id,
            agentId: thread.agentId,
            opening: null,
            items: [],
            ends: true,
            work: inThread(thread.id),
          };
    }
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

/** The keys of the items memory acknowledged in each open session, so a page does not send them again. */
export type SentKeys = ReadonlyMap<MemorySessionId, ReadonlySet<string>>;

/** A page of the journal, as the worker sends it: each session's items in order, and the sessions it ends. */
interface Round {
  readonly sequence: number;
  readonly groups: ReadonlyMap<
    MemorySessionId,
    { readonly agentId: AgentId; readonly items: Array<MemoryCaptureItem> }
  >;
  readonly sessions: Map<MemorySessionId, MemoryCaptureSession>;
  readonly touched: Set<MemorySessionId>;
  readonly ended: Array<MemoryCaptureSession>;
  /** Entries with something to send that were committed longer ago than memory skips a replay. */
  readonly stale: number;
  /** The keys sent to each session it touched, those sent before included. */
  readonly sent: ReadonlyMap<MemorySessionId, ReadonlySet<string>>;
}

/** A page of journal entries, and what memory keeps of each. */
export interface CapturedPage {
  readonly entries: ReadonlyArray<EventEnvelope>;
  readonly found: ReadonlyArray<CapturedEntry | null>;
}

/** What memory keeps of each entry of a page, redacted by `redactor`. */
const capturePage = (entries: ReadonlyArray<EventEnvelope>, redactor: Redactor): CapturedPage => ({
  entries,
  found: entries.map((entry) => capturedEntryOf(entry, redactor)),
});

/** The threads and Tasks a page's entries belong to, to ask which are private camps. */
const workOfPage = (page: CapturedPage): MemoryCaptureWork => {
  const threadIds = new Set<ThreadId>();
  const taskIds = new Set<TaskId>();
  for (const found of page.found) {
    if (found === null) continue;
    if (found.work.threadId !== null) threadIds.add(found.work.threadId);
    if (found.work.taskId !== null) taskIds.add(found.work.taskId);
  }
  return { threadIds, taskIds };
};

/** No private camps: what a page plans when none of its work is in one. */
const NO_PRIVATE_WORK: MemoryCaptureWork = { threadIds: new Set(), taskIds: new Set() };

/** Whether an entry happened in a private camp, or worked on a Task of one (ADR 037). */
const isPrivate = (found: CapturedEntry, work: MemoryCaptureWork) =>
  (found.work.threadId !== null && work.threadIds.has(found.work.threadId)) ||
  (found.work.taskId !== null && work.taskIds.has(found.work.taskId));

/**
 * Plans what a page of entries sends, from the sessions open before it and the keys already sent to
 * them. An entry that only ends a session, as an archive does, does nothing when its session is not
 * open; any other entry opens its session again, which memory continues. Nothing of a private camp
 * (`privateWork`) is sent (ADR 037): its entries are skipped, and a session of it still open from
 * before the camp was made private ends, so what memory has of it stays and nothing more is added.
 */
export const planRound = (
  page: CapturedPage,
  open: ReadonlyArray<MemoryCaptureSession>,
  staleBefore: string,
  sent: SentKeys = new Map(),
  privateWork: MemoryCaptureWork = NO_PRIVATE_WORK,
): Round => {
  const sessions = new Map(open.map((session) => [session.sessionId, session]));
  const groups = new Map<MemorySessionId, { readonly agentId: AgentId; readonly items: Array<MemoryCaptureItem> }>();
  const planned = new Map<MemorySessionId, Set<string>>();
  const touched = new Set<MemorySessionId>();
  const ending = new Map<MemorySessionId, MemoryCaptureSession>();
  let stale = 0;
  /** Adds what `found` brings that its session was not sent yet, and answers whether it brought anything. */
  const add = (entry: EventEnvelope, found: CapturedEntry, opened: boolean) => {
    const { sessionId } = found;
    const keys = planned.get(sessionId) ?? new Set(sent.get(sessionId));
    planned.set(sessionId, keys);
    // A session that goes on later keeps its first start: the opening's keys never change.
    // An item keeps the time it happened, its entry's when it has none of its own, however late it is sent.
    const items = [...(opened ? [] : (found.opening ?? [])), ...found.items]
      .filter((item) => !keys.has(item.key))
      .map((item) => (item.at === undefined ? { ...item, at: entry.occurredAt } : item));
    if (items.length === 0) return false;
    if (entry.occurredAt < staleBefore) stale += 1;
    const group = groups.get(sessionId) ?? { agentId: sessions.get(sessionId)?.agentId ?? found.agentId, items: [] };
    groups.set(sessionId, group);
    for (const item of items) keys.add(item.key);
    group.items.push(...items);
    const last = items.at(-1) as MemoryCaptureItem;
    sessions.set(sessionId, { sessionId, agentId: group.agentId, lastAt: entry.occurredAt, lastKey: last.key });
    return true;
  };
  page.entries.forEach((entry, at) => {
    const found = page.found[at] ?? null;
    if (found === null) return;
    const { sessionId } = found;
    if (isPrivate(found, privateWork)) {
      const session = sessions.get(sessionId);
      if (session !== undefined) ending.set(sessionId, session);
      return;
    }
    const opened = sessions.has(sessionId);
    if (!opened && found.opening === null) return;
    if (add(entry, found, opened)) {
      touched.add(sessionId);
      ending.delete(sessionId);
    }
    const session = sessions.get(sessionId);
    if (found.ends && session !== undefined) ending.set(sessionId, session);
  });
  for (const sessionId of ending.keys()) {
    sessions.delete(sessionId);
    touched.delete(sessionId);
  }
  const sequence = page.entries.at(-1)?.sequence ?? 0;
  return { sequence, groups, sessions, touched, ended: [...ending.values()], stale, sent: planned };
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
      let sent = new Map<MemorySessionId, ReadonlySet<string>>();
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
          const page = capturePage(entries, redactor);
          const privateWork = yield* log.privateWork(workOfPage(page));
          const round = planRound(page, current.sessions, yield* before(MEMORY_KEY_WINDOW), sent, privateWork);
          if (round.stale > 0) {
            yield* Effect.logWarning(
              `Memory capture is sending ${round.stale} journal entries older than memory's 30-day replay window; if any reached memory before, it may keep them twice.`,
            );
          }
          for (const [sessionId, group] of round.groups) {
            const acknowledged = yield* store.capture(
              hobActor(group.agentId),
              ownScope(group.agentId),
              sessionId,
              group.items,
            );
            if (acknowledged < group.items.length) {
              return yield* new MemoryUnavailable({ message: "Memory took only part of a session's capture." });
            }
          }
          // An end memory put off, under a chat note you pinned, keeps its session open to send again.
          const waiting: Array<MemoryCaptureSession> = [];
          for (const session of round.ended) if (!(yield* endSession(session))) waiting.push(session);
          for (const session of waiting) round.sessions.set(session.sessionId, session);
          const active = [
            ...[...round.touched].map((sessionId) => round.sessions.get(sessionId) as MemoryCaptureSession),
            ...waiting,
          ];
          // Saved as soon as memory acknowledged the page: a crash before this sends it once more, and
          // memory skips what it has seen.
          yield* log.save(
            round.sequence,
            active,
            round.ended.filter((session) => !waiting.includes(session)).map((session) => session.sessionId),
          );
          state = { sequence: round.sequence, sessions: [...round.sessions.values()] };
          for (const [sessionId, keys] of round.sent) {
            if (round.sessions.has(sessionId)) sent.set(sessionId, keys);
            else sent.delete(sessionId);
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
          const ended = new Set<MemorySessionId>();
          for (const session of quiet) if (yield* endSession(session)) ended.add(session.sessionId);
          if (ended.size === 0) return;
          yield* log.save(current.sequence, [], [...ended]);
          state = { ...current, sessions: current.sessions.filter((session) => !ended.has(session.sessionId)) };
          for (const sessionId of ended) sent.delete(sessionId);
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
