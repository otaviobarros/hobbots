import {
  type AgentId,
  type Attempt,
  type AttemptId,
  type EventEnvelope,
  isLiveAttempt,
  isTerminalTask,
  type MemoryActor,
  type MemoryCaptureItem,
  type MemoryExpected,
  type MemorySave,
  type MemorySessionId,
  MemoryUnavailable,
  type Message,
  type MessageStatus,
  type ReplyStep,
  type ReplyStepState,
  type Task,
  type TaskId,
  type ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, Duration, Effect, Layer, Option, Schedule } from "effect";
import {
  MemoryCaptureLog,
  type MemoryCaptureSession,
  type MemoryCaptureState,
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
 * that hob's memory (#1012). It moves the cursor once memory acknowledged all of it. A session quiet
 * for 30 minutes, or whose thread was archived or whose Task ended, is ended, so memory writes its
 * summary page; no runtime turn is spent on it. The same worker sends the `memory_save` calls memory
 * could not take at once. While memory does not answer, nothing moves and nothing is lost: journal
 * compaction keeps every entry after the cursor.
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
const ENDED_STEP: ReadonlySet<ReplyStepState> = new Set(["done", "failed", "denied", "uncertain"]);

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

/** What a reply that ended adds to its thread's session: its tool steps, then its text. */
const replyItems = (entry: EventEnvelope, message: Message): Array<MemoryCaptureItem> => {
  if (!ENDED_REPLY.has(message.status)) return [];
  const steps = message.steps
    .filter((step) => step.kind === "tool" && ENDED_STEP.has(step.state))
    // A step keeps its key when Continue resumes its reply, so memory skips it the second time.
    .map((step): MemoryCaptureItem => ({ key: `step:${message.id}:${step.id}`, kind: "tool", text: stepText(step) }));
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
  /** The session ends: its thread was archived, or its Task ended. */
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
 * What memory keeps of a journal entry, redacted by `redactor`, or null for an entry it keeps
 * nothing of. A message of yours is kept once it is no longer queued, by its own id, so saving it
 * again sends nothing new; a reply once its turn ends. An Attempt outside any chat keeps its Task's
 * goal, its finished tool steps and each turn's reply.
 */
export const capturedEntryOf = (entry: EventEnvelope, redactor: Redactor): CapturedEntry | null => {
  const event = entry.payload;
  const redacted: Redacting = (items) => items.map((item) => ({ ...item, text: cut(redactor.text(item.text)) }));
  switch (event._tag) {
    case "MessageUpserted": {
      const agentId = entry.correlation.agentId;
      if (agentId === null) return null;
      const { message } = event;
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
          };
    }
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
      const { thread } = event;
      return thread.archivedAt === null
        ? null
        : { sessionId: thread.id, agentId: thread.agentId, opening: null, items: [], ends: true };
    }
    case "TaskStateChanged":
      return taskChangeOf(entry, event, redacted);
    case "AttemptStepsRecorded": {
      // Every change carries all the Attempt's steps: each finished one is kept once, by its own id.
      const agentId = entry.correlation.agentId;
      if (agentId === null) return null;
      const steps = event.steps
        .filter((step) => step.kind === "tool" && ENDED_STEP.has(step.state))
        .map(
          (step): MemoryCaptureItem => ({
            key: `step:${event.attemptId}:${step.id}`,
            kind: "tool",
            text: stepText(step),
          }),
        );
      // Steps only run in an Attempt outside any chat. One that finishes after its session ended for
      // quiet opens it again, by the same start: the goal it was sent first is already there.
      return steps.length === 0
        ? null
        : {
            sessionId: event.attemptId,
            agentId,
            opening: [attemptStart(event.attemptId, event.taskId, entry.correlation.threadId)],
            items: redacted(steps),
            ends: false,
          };
    }
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

/**
 * Plans what a page of entries sends, from the sessions open before it and the keys already sent to
 * them. An entry that only ends a session, as an archive does, does nothing when its session is not
 * open; any other entry opens its session again, which memory continues.
 */
export const planRound = (
  entries: ReadonlyArray<EventEnvelope>,
  open: ReadonlyArray<MemoryCaptureSession>,
  redactor: Redactor,
  staleBefore: string,
  sent: SentKeys = new Map(),
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
    const items = [...(opened ? [] : (found.opening ?? [])), ...found.items].filter((item) => !keys.has(item.key));
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
  for (const entry of entries) {
    const found = capturedEntryOf(entry, redactor);
    if (found === null) continue;
    const { sessionId } = found;
    const opened = sessions.has(sessionId);
    if (!opened && found.opening === null) continue;
    if (add(entry, found, opened)) {
      touched.add(sessionId);
      ending.delete(sessionId);
    }
    const session = sessions.get(sessionId);
    if (found.ends && session !== undefined) ending.set(sessionId, session);
  }
  for (const sessionId of ending.keys()) {
    sessions.delete(sessionId);
    touched.delete(sessionId);
  }
  const sequence = entries.at(-1)?.sequence ?? 0;
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
          const round = planRound(entries, current.sessions, redactor, yield* before(MEMORY_KEY_WINDOW), sent);
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
