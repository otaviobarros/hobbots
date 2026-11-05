import {
  type AgentId,
  type EventEnvelope,
  type MemoryActor,
  type MemoryCaptureItem,
  MemoryUnavailable,
  type Message,
  type MessageStatus,
  type ReplyStep,
  type ReplyStepState,
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
 * in its hob's own memory, and moves the cursor once memory acknowledged all of it. A thread quiet
 * for 30 minutes, or archived, has its session ended, so memory writes its summary page; no runtime
 * turn is spent on it. The same worker sends the `memory_save` calls memory could not take at once.
 * While memory does not answer, nothing moves and nothing is lost: journal compaction keeps every
 * entry after the cursor.
 */

/** How long a thread is quiet before its session ends. */
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

/** What one journal entry adds to a thread's session in its hob's memory, if anything. */
export interface CapturedEntry {
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly items: ReadonlyArray<MemoryCaptureItem>;
  /** The thread was archived: its session ends. */
  readonly archived: boolean;
}

/**
 * What memory keeps of a journal entry, redacted by `redactor`, or null for an entry it keeps
 * nothing of. A message of yours is kept once it is no longer queued, by its own id, so saving it
 * again sends nothing new; a reply once its turn ends.
 */
export const capturedEntryOf = (entry: EventEnvelope, redactor: Redactor): CapturedEntry | null => {
  const event = entry.payload;
  const redacted = (items: ReadonlyArray<MemoryCaptureItem>) =>
    items.map((item) => ({ ...item, text: cut(redactor.text(item.text)) }));
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
        : { threadId: message.threadId, agentId, items: redacted(items), archived: false };
    }
    case "QuestStarted": {
      // A top Quest started in a thread is led by the thread's hob; a member's own Quests are not its.
      const { quest } = event;
      if (quest.threadId === null || quest.parentQuestId !== null) return null;
      const text = `quest:${quest.id}\n${quest.goal}`;
      return {
        threadId: quest.threadId,
        agentId: quest.leadId,
        items: redacted([{ key: `quest:${quest.id}`, kind: "quest", text }]),
        archived: false,
      };
    }
    case "ThreadUpserted": {
      const { thread } = event;
      return thread.archivedAt === null
        ? null
        : { threadId: thread.id, agentId: thread.agentId, items: [], archived: true };
    }
    default:
      return null;
  }
};

const hobActor = (agentId: AgentId): MemoryActor => ({ _tag: "Hob", agentId, projects: [] });
const ownScope = (agentId: AgentId) => ({ _tag: "Hob", agentId }) as const;
const endKey = (session: MemoryCaptureSession) => `end:${session.threadId}:${session.lastKey}`;

/** A page of the journal, as the worker sends it: each thread's items in order, and the sessions it ends. */
interface Round {
  readonly sequence: number;
  readonly groups: ReadonlyMap<ThreadId, { readonly agentId: AgentId; readonly items: Array<MemoryCaptureItem> }>;
  readonly sessions: Map<ThreadId, MemoryCaptureSession>;
  readonly touched: Set<ThreadId>;
  readonly ended: Array<MemoryCaptureSession>;
  /** Entries with something to send that were committed longer ago than memory skips a replay. */
  readonly stale: number;
}

/** Plans what a page of entries sends, from the sessions open before it. */
export const planRound = (
  entries: ReadonlyArray<EventEnvelope>,
  open: ReadonlyArray<MemoryCaptureSession>,
  redactor: Redactor,
  staleBefore: string,
): Round => {
  const sessions = new Map(open.map((session) => [session.threadId, session]));
  const groups = new Map<ThreadId, { readonly agentId: AgentId; readonly items: Array<MemoryCaptureItem> }>();
  const touched = new Set<ThreadId>();
  const ending = new Map<ThreadId, MemoryCaptureSession>();
  let stale = 0;
  for (const entry of entries) {
    const found = capturedEntryOf(entry, redactor);
    if (found === null) continue;
    const { threadId } = found;
    if (found.items.length > 0) {
      if (entry.occurredAt < staleBefore) stale += 1;
      let group = groups.get(threadId);
      if (group === undefined) {
        group = { agentId: sessions.get(threadId)?.agentId ?? found.agentId, items: [] };
        groups.set(threadId, group);
        // Every session starts with its thread. Its key never changes, so a session that goes on later
        // keeps its first start.
        if (!sessions.has(threadId)) {
          group.items.push({ key: `start:${threadId}`, kind: "start", text: `thread:${threadId}` });
        }
      }
      group.items.push(...found.items);
      const last = found.items.at(-1) as MemoryCaptureItem;
      sessions.set(threadId, { threadId, agentId: group.agentId, lastAt: entry.occurredAt, lastKey: last.key });
      touched.add(threadId);
      ending.delete(threadId);
    }
    if (found.archived) {
      const session = sessions.get(threadId);
      if (session !== undefined) ending.set(threadId, session);
    }
  }
  for (const threadId of ending.keys()) {
    sessions.delete(threadId);
    touched.delete(threadId);
  }
  const sequence = entries.at(-1)?.sequence ?? 0;
  return { sequence, groups, sessions, touched, ended: [...ending.values()], stale };
};

export interface MemoryCaptureShape {
  /**
   * One round: sends the saves memory has not taken yet, then the journal after the cursor until it is
   * caught up, then ends the sessions of threads quiet for 30 minutes. Stops early, with nothing lost,
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

      /** The `memory_save` calls memory did not take, sent again with the same record (ADR 028, When memory is down). */
      const sendSaves = Effect.gen(function* () {
        if (Option.isNone(saves)) return;
        const staleSending = yield* before(SENDING_STALE);
        const unsent = (yield* saves.value.unsent).filter(
          (save) =>
            save.scope._tag === "Hob" &&
            (save.state === "queued" || (save.state === "sending" && save.updatedAt < staleSending)),
        );
        for (const save of unsent) {
          const draft = { path: save.path, markdown: save.markdown, tags: save.tags, pinned: false };
          const outcome = yield* store.write(hobActor(save.agentId), save.scope, draft, { _tag: "Any" }).pipe(
            Effect.map((version) => ({ state: "saved", version }) as const),
            Effect.catchTag("MemoryConflict", () => Effect.succeed({ state: "refused", version: null } as const)),
          );
          const committed = yield* saves.value.settle(save, outcome.state, outcome.version, yield* now);
          if (Option.isSome(committed)) yield* announce(committed.value.entries);
        }
      });

      const endSession = (session: MemoryCaptureSession) =>
        store.endSession(hobActor(session.agentId), ownScope(session.agentId), session.threadId, endKey(session));

      /** Sends one page of the journal; answers whether the journal had nothing more. */
      const sendPage = (current: MemoryCaptureState) =>
        Effect.gen(function* () {
          const entries = yield* log.readAfter(current.sequence, PAGE);
          if (entries.length === 0) return true;
          const round = planRound(entries, current.sessions, redactor, yield* before(MEMORY_KEY_WINDOW));
          if (round.stale > 0) {
            yield* Effect.logWarning(
              `Memory capture is sending ${round.stale} journal entries older than memory's 30-day replay window; if any reached memory before, it may keep them twice.`,
            );
          }
          for (const [threadId, group] of round.groups) {
            const acknowledged = yield* store.capture(
              hobActor(group.agentId),
              ownScope(group.agentId),
              threadId,
              group.items,
            );
            if (acknowledged < group.items.length) {
              return yield* new MemoryUnavailable({ message: "Memory took only part of a thread's capture." });
            }
          }
          for (const session of round.ended) yield* endSession(session);
          const active = [...round.touched].map((threadId) => round.sessions.get(threadId) as MemoryCaptureSession);
          // Saved as soon as memory acknowledged the page: a crash before this sends it once more, and
          // memory skips what it has seen.
          yield* log.save(
            round.sequence,
            active,
            round.ended.map((session) => session.threadId),
          );
          state = { sequence: round.sequence, sessions: [...round.sessions.values()] };
          return entries.length < PAGE;
        });

      /** Ends the sessions of threads quiet for 30 minutes, once the journal is caught up. */
      const endQuiet = (current: MemoryCaptureState) =>
        Effect.gen(function* () {
          const quietBefore = yield* before(MEMORY_SESSION_QUIET);
          const quiet = current.sessions.filter((session) => session.lastAt < quietBefore);
          if (quiet.length === 0) return;
          for (const session of quiet) yield* endSession(session);
          const ended = new Set(quiet.map((session) => session.threadId));
          yield* log.save(current.sequence, [], [...ended]);
          state = { ...current, sessions: current.sessions.filter((session) => !ended.has(session.threadId)) };
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
