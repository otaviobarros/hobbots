import type { TraceEntry } from "@hobbots/api";
import {
  AgentId,
  type Committed,
  EVENT_SCHEMA_VERSIONS,
  type EventCorrelation,
  EventEnvelope,
  type HubQuestion,
  JournaledEvent,
  type JournaledEvent as JournaledEventType,
  ThreadId,
  type WebFetchRecord,
  type WebSearchRecord,
} from "@hobbots/domain";
import { Context, Data, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { recordBackpackItems } from "./backpack-rows.ts";
import { endTaskGrants } from "./task-grants.ts";

/** Where the journal stands: its epoch (new for every fresh database) and the last committed sequence. */
export interface JournalHead {
  readonly epoch: string;
  readonly sequence: number;
}

/** How long entries are kept, and how many of the latest are always kept, whichever retains more (ADR 013). */
export const JOURNAL_RETENTION = { age: Duration.days(7), entries: 10_000 } as const;

const encodePayload = Schema.encodeSync(JournaledEvent);
const decodeEnvelope = Schema.decodeUnknownEffect(EventEnvelope);

// What the journal row is correlated with. A Task's records name only their Task, so the row takes
// the Task's owner and thread from the tasks table, as a message event takes its hob from its thread.
interface RowCorrelation extends EventCorrelation {
  readonly taskId: string | null;
}

const byTask = (task: { readonly ownerId: AgentId; readonly threadId: ThreadId | null; readonly id: string }) => ({
  agentId: task.ownerId,
  threadId: task.threadId,
  messageId: null,
  taskId: task.id,
});

const NONE: RowCorrelation = { agentId: null, threadId: null, messageId: null, taskId: null };

type TaskEvent = Extract<
  JournaledEventType,
  {
    readonly _tag:
      | "TaskCreated"
      | "TaskStateChanged"
      | "TaskCompleted"
      | "QuestStarted"
      | "QuestCompleted"
      | "CheckpointRecorded"
      | "QuestionAsked"
      | "QuestionAnswered"
      | "QuestionEscalated"
      | "QuestionWithdrawn"
      | "NoteLeft"
      | "NotePickedUp"
      | "HandedOff";
  }
>;

const isTaskEvent = (event: JournaledEventType): event is TaskEvent =>
  "task" in event ||
  "quest" in event ||
  "checkpoint" in event ||
  "question" in event ||
  "note" in event ||
  "handOff" in event;

const taskCorrelationOf = (event: TaskEvent): RowCorrelation => {
  if ("task" in event) return byTask(event.task);
  if ("quest" in event)
    return { ...NONE, agentId: event.quest.leadId, threadId: event.quest.threadId, taskId: event.quest.taskId };
  if ("question" in event) return { ...NONE, agentId: event.question.askerId, taskId: event.question.taskId };
  // A note is correlated with the chat message of yours it traces back to, when there is one (#900).
  if ("note" in event)
    return { ...NONE, agentId: event.note.recipientId, messageId: event.note.messageId, taskId: event.note.taskId };
  return { ...NONE, taskId: "checkpoint" in event ? event.checkpoint.taskId : event.handOff.toTaskId };
};

type ThreadEvent = Extract<JournaledEventType, { readonly _tag: "ThreadUpserted" | "CampMade" | "ChatStartedFresh" }>;
const THREAD_EVENTS: ReadonlySet<string> = new Set(["ThreadUpserted", "CampMade", "ChatStartedFresh"]);
const isThreadEvent = (event: JournaledEventType): event is ThreadEvent => THREAD_EVENTS.has(event._tag);

/** A thread's own events; Start fresh is journaled in the new chat, whose origin names the chat it replaced. */
const threadCorrelationOf = (event: ThreadEvent): RowCorrelation => {
  const thread = event._tag === "ChatStartedFresh" ? event.chat : event.thread;
  return { ...NONE, agentId: thread.agentId, threadId: thread.id };
};

const correlationOf = (event: JournaledEventType): RowCorrelation => {
  if (isWebEvent(event)) return webCorrelationOf(event);
  if (isThreadEvent(event)) return threadCorrelationOf(event);
  switch (event._tag) {
    case "AgentUpserted":
      return { ...NONE, agentId: event.agent.id };
    case "ApprovalRequested":
    case "ApprovalResolved":
      return {
        ...NONE,
        agentId: event.approval.agentId,
        threadId: event.approval.threadId,
        messageId: event.approval.messageId,
        taskId: event.approval.taskId,
      };
    case "GrantCreated":
    case "GrantRevoked":
      return { ...NONE, agentId: event.grant.agentId };
    case "BackpackItemRecorded":
    case "BackpackItemChanged":
      return { ...NONE, agentId: event.item.recipientId, threadId: event.item.threadId, taskId: event.item.taskId };
    case "DeviceRevoked":
      return NONE;
    case "MessageUpserted":
    case "MessageQueued":
      return { ...NONE, threadId: event.message.threadId, messageId: event.message.id };
    // Pairing belongs to no hob or thread (ADR 021).
    case "PairingRequested":
    case "PairingChanged":
      return NONE;
    default:
      return restCorrelationOf(event);
  }
};

type WebEvent = Extract<
  JournaledEventType,
  { readonly _tag: "WebSearched" | "WebFetched" | "WebSettingsChanged" | "HobWebLimitsChanged" }
>;
const WEB_EVENTS: ReadonlySet<string> = new Set([
  "WebSearched",
  "WebFetched",
  "WebSettingsChanged",
  "HobWebLimitsChanged",
]);
const isWebEvent = (event: JournaledEventType): event is WebEvent => WEB_EVENTS.has(event._tag);

/** A web record names its hob, chat, reply and Task (ADR 036); Settings › Web belongs to no hob. */
const webCorrelationOf = (event: WebEvent): RowCorrelation => {
  const record: WebSearchRecord | WebFetchRecord | null =
    event._tag === "WebSearched" ? event.search : event._tag === "WebFetched" ? event.fetch : null;
  if (record !== null) {
    return { agentId: record.agentId, threadId: record.threadId, messageId: record.messageId, taskId: record.taskId };
  }
  return event._tag === "HobWebLimitsChanged" ? { ...NONE, agentId: event.agentId } : NONE;
};

const hubQuestionCorrelation = (question: HubQuestion): RowCorrelation =>
  question.chat === null ? NONE : { ...NONE, agentId: question.chat.agentId, threadId: question.chat.threadId };

type SkillEvent = Extract<JournaledEventType, { readonly _tag: `Skill${string}` }>;
const isSkillEvent = (event: JournaledEventType): event is SkillEvent => event._tag.startsWith("Skill");

/** The library belongs to no hob; a hob's own assignment, its opt-outs, uses, proposals and notes name it (ADR 029). */
const skillCorrelationOf = (event: SkillEvent): RowCorrelation => {
  // A use names the hob that used it, and its thread and reply when it came from one.
  if ("use" in event)
    return { ...NONE, agentId: event.use.agentId, threadId: event.use.threadId, messageId: event.use.messageId };
  if ("optOut" in event) return { ...NONE, agentId: event.optOut.agentId };
  // A proposal and a note name the hob, and the reply they came from.
  const call = "proposal" in event ? event.proposal : "feedback" in event ? event.feedback : null;
  if (call !== null) return { ...NONE, agentId: call.agentId, threadId: call.threadId, messageId: call.messageId };
  if (!("assignment" in event)) return NONE;
  const { scope } = event.assignment;
  return scope._tag === "Hob" ? { ...NONE, agentId: scope.agentId } : NONE;
};

type WorkbenchRecord = Extract<
  JournaledEventType,
  {
    readonly _tag:
      | "CommandRecorded"
      | "FileChangesRecorded"
      | "FolderScanned"
      | "AttemptStepsRecorded"
      | "AttemptReadWeb";
  }
>;

const WORKBENCH_RECORDS: ReadonlySet<JournaledEventType["_tag"]> = new Set([
  "CommandRecorded",
  "FileChangesRecorded",
  "FolderScanned",
  "AttemptStepsRecorded",
  "AttemptReadWeb",
]);

const isWorkbenchRecord = (event: JournaledEventType): event is WorkbenchRecord => WORKBENCH_RECORDS.has(event._tag);

/** The Task a Workbench record names (ADR 023). */
const workbenchTaskOf = (event: WorkbenchRecord): string => {
  if (event._tag === "CommandRecorded") return event.command.taskId;
  return event._tag === "FolderScanned" ? event.scan.taskId : event.taskId;
};

/** Task and Workbench events, and the message events that name their thread and message. */
const restCorrelationOf = (
  event: Exclude<
    JournaledEventType,
    {
      readonly _tag:
        | "AgentUpserted"
        | "ThreadUpserted"
        | "CampMade"
        | "ChatStartedFresh"
        | "ApprovalRequested"
        | "ApprovalResolved"
        | "GrantCreated"
        | "GrantRevoked"
        | "BackpackItemRecorded"
        | "BackpackItemChanged"
        | "DeviceRevoked"
        | "MessageUpserted"
        | "MessageQueued"
        | "PairingRequested"
        | "PairingChanged"
        | "WebSearched"
        | "WebFetched"
        | "WebSettingsChanged"
        | "HobWebLimitsChanged";
    }
  >,
): RowCorrelation => {
  // A hub question has no Task (#976): it names the chat it concerns, if any.
  if ("hubQuestion" in event) return hubQuestionCorrelation(event.hubQuestion);
  if (isTaskEvent(event)) return taskCorrelationOf(event);
  if (isSkillEvent(event)) return skillCorrelationOf(event);
  // The Workbench's records name their Task (ADR 023).
  if (isWorkbenchRecord(event)) return { ...NONE, taskId: workbenchTaskOf(event) };
  switch (event._tag) {
    case "ToolCallRefused":
      return { ...NONE, agentId: event.refusal.agentId, taskId: event.refusal.taskId };
    // A hob's save names its hob, and the reply it was made from when it came from a chat turn.
    case "MemorySaveRecorded":
    case "MemorySaveChanged":
      return { ...NONE, agentId: event.save.agentId, threadId: event.save.threadId, messageId: event.save.messageId };
    // A share names its hob, and the reply it was asked from when it came from a chat turn.
    case "MemoryShareRequested":
    case "MemoryShareChanged":
      return {
        ...NONE,
        agentId: event.share.agentId,
        threadId: event.share.threadId,
        messageId: event.share.messageId,
      };
    // A hob proposal names its manager, and the reply or Task it was proposed from (ADR 034).
    case "HobProposalRequested":
    case "HobProposalChanged":
      return {
        ...NONE,
        agentId: event.proposal.agentId,
        threadId: event.proposal.threadId,
        messageId: event.proposal.messageId,
        taskId: event.proposal.taskId,
      };
    // A chapter change names its thread (ADR 037); a split, the message it cut at, below.
    case "ChapterStarted":
    case "ChapterMerged":
      return { ...NONE, threadId: event.threadId };
    default:
      return { ...NONE, threadId: event.threadId, messageId: event.messageId };
  }
};

/**
 * Appends to the journal from inside a writing transaction. Repositories reserve the sequences a
 * change needs before writing it, so the head row's lock orders concurrent writers on PostgreSQL,
 * then append the events once the change is written. Only for use within `sql.withTransaction`.
 */
const makeJournalWriter = (sql: SqlClient.SqlClient) => {
  /** Hands out the next `count` sequences and returns the first. */
  const reserve = (count: number): Effect.Effect<number, SqlError.SqlError> =>
    sql<{ readonly sequence: unknown }>`UPDATE event_journal_head SET sequence = sequence + ${count}
      WHERE id = 1 RETURNING sequence`.pipe(Effect.map(([row]) => Number(row?.sequence) - count + 1));

  /** Appends `events` at the sequences from `first` on; a message event's hob is read from its thread. */
  const append = (
    first: number,
    events: ReadonlyArray<JournaledEventType>,
  ): Effect.Effect<ReadonlyArray<EventEnvelope>, SqlError.SqlError> =>
    Effect.gen(function* () {
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.forEach(events, (payload, index) =>
        Effect.gen(function* () {
          const id = crypto.randomUUID();
          const sequence = first + index;
          const type = payload._tag;
          const schemaVersion = EVENT_SCHEMA_VERSIONS[type];
          const { agentId, threadId, messageId, taskId } = correlationOf(payload);
          const agent =
            taskId === null
              ? sql`COALESCE(${agentId}, (SELECT agent_id FROM threads WHERE id = ${threadId}))`
              : sql`COALESCE(${agentId}, (SELECT owner_id FROM tasks WHERE id = ${taskId}))`;
          const thread =
            taskId === null
              ? sql`${threadId}`
              : // A note on a member's Task is in the thread of the message of yours it traces back to (#900).
                sql`COALESCE(${threadId}, (SELECT thread_id FROM messages WHERE id = ${messageId}),
                  (SELECT thread_id FROM tasks WHERE id = ${taskId}))`;
          const [row] = yield* sql<{
            readonly agentId: string | null;
            readonly threadId: string | null;
          }>`INSERT INTO event_journal
              (sequence, id, type, schema_version, occurred_at, agent_id, thread_id, message_id, causation_id, payload)
            VALUES (
              ${sequence}, ${id}, ${type}, ${schemaVersion}, ${occurredAt}, ${agent}, ${thread}, ${messageId}, NULL, ${JSON.stringify(encodePayload(payload))}
            )
            RETURNING agent_id, thread_id`;
          return new EventEnvelope({
            id,
            sequence,
            schemaVersion,
            type,
            occurredAt,
            correlation: {
              agentId: row?.agentId == null ? null : AgentId.make(row.agentId),
              threadId: row?.threadId == null ? null : ThreadId.make(row.threadId),
              messageId,
            },
            causationId: null,
            payload,
          });
        }),
      );
    });

  /**
   * Locks the head row for the rest of the transaction without taking sequences yet, and returns
   * the first sequence the transaction's events will take. `advance` then takes them.
   */
  const lock: Effect.Effect<number, SqlError.SqlError> = sql<{ readonly sequence: unknown }>`UPDATE event_journal_head
    SET sequence = sequence WHERE id = 1 RETURNING sequence`.pipe(Effect.map(([row]) => Number(row?.sequence) + 1));

  const advance = (first: number, count: number) =>
    sql`UPDATE event_journal_head SET sequence = ${first + count - 1} WHERE id = 1`.pipe(Effect.asVoid);

  return { reserve, append, lock, advance };
};

/**
 * Takes the journal's head row for the rest of the transaction, so writers that span several
 * journaled changes still take turns on PostgreSQL.
 */
export const lockJournal = (sql: SqlClient.SqlClient) => makeJournalWriter(sql).lock.pipe(Effect.asVoid);

/**
 * The events a change's own events call for in the same transaction, at sequences from `first` on:
 * the backpack items they record (ADR 019), then the grants of the top Tasks they end (ADR 018).
 */
const derivedFrom = (sql: SqlClient.SqlClient, events: ReadonlyArray<JournaledEventType>, first: number) =>
  Effect.gen(function* () {
    const items = yield* recordBackpackItems(sql, events, first);
    return [...items, ...(yield* endTaskGrants(sql, events, first + items.length))];
  });

// A conditional write found nothing to change; its transaction rolls back, releasing its sequences.
class NothingChanged extends Data.TaggedError("NothingChanged") {}

/**
 * Runs a change in one transaction with the journal sequences its events take, from `first`,
 * reserved before it writes, and appends its events before commit: the journal is the outbox
 * (ADR 013). The backpack items its events call for are recorded in the same transaction, with
 * their own events after the change's (ADR 019), as are the grants of the top Tasks it ends
 * (ADR 018). A change that returns null wrote nothing, and rolls back.
 */
export const makeJournaled =
  (sql: SqlClient.SqlClient) =>
  <A>(
    count: number,
    write: (
      first: number,
    ) => Effect.Effect<
      { readonly value: A; readonly events: ReadonlyArray<JournaledEventType> } | null,
      SqlError.SqlError
    >,
  ): Effect.Effect<Option.Option<Committed<A>>> => {
    const journal = makeJournalWriter(sql);
    return Effect.gen(function* () {
      const first = yield* journal.reserve(count);
      const change = yield* write(first);
      if (change === null) return yield* new NothingChanged();
      if (change.events.length !== count) {
        return yield* Effect.die(new Error(`Reserved ${count} journal sequences for ${change.events.length} events`));
      }
      // What the change calls for takes the sequences after its own: the backpack items it records
      // (ADR 019), then the This Task grants of the top Tasks it ends (ADR 018).
      const derived = yield* derivedFrom(sql, change.events, first + count);
      if (derived.length > 0) yield* journal.reserve(derived.length);
      return { value: change.value, entries: yield* journal.append(first, [...change.events, ...derived]) };
    }).pipe(
      sql.withTransaction,
      Effect.map(Option.some),
      Effect.catchTag("NothingChanged", () => Effect.succeed(Option.none())),
      Effect.orDie,
    );
  };

/**
 * Runs a change in one transaction, as `makeJournaled` does, for a change that learns how many
 * events it journals only as it reads, and that can be refused. The head row is locked first, so
 * concurrent writers still take turns on PostgreSQL; the events take the sequences from `first`.
 * A refusal (`E`) rolls the whole change back and is returned as the failure.
 */
export const makeJournaledChange =
  (sql: SqlClient.SqlClient) =>
  <A, E extends { readonly _tag: string }>(
    write: (
      first: number,
    ) => Effect.Effect<
      { readonly value: A; readonly events: ReadonlyArray<JournaledEventType> },
      SqlError.SqlError | E
    >,
  ): Effect.Effect<Committed<A>, Exclude<E, SqlError.SqlError>> => {
    const journal = makeJournalWriter(sql);
    return Effect.gen(function* () {
      const first = yield* journal.lock;
      const change = yield* write(first);
      const events = [...change.events, ...(yield* derivedFrom(sql, change.events, first + change.events.length))];
      yield* journal.advance(first, events.length);
      return { value: change.value, entries: yield* journal.append(first, events) };
    }).pipe(
      sql.withTransaction,
      Effect.catchIf(
        (error): error is SqlError.SqlError => SqlError.isSqlError(error),
        (error) => Effect.die(error),
      ),
    ) as Effect.Effect<Committed<A>, Exclude<E, SqlError.SqlError>>;
  };

interface JournalRow {
  readonly sequence: unknown;
  readonly id: string;
  readonly schemaVersion: unknown;
  readonly type: string;
  readonly occurredAt: string;
  readonly agentId: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly causationId: string | null;
  readonly payload: string;
}

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every sequence fits a number.
const toEnvelope = (row: JournalRow) =>
  decodeEnvelope({
    id: row.id,
    sequence: Number(row.sequence),
    schemaVersion: Number(row.schemaVersion),
    type: row.type,
    occurredAt: row.occurredAt,
    correlation: { agentId: row.agentId, threadId: row.threadId, messageId: row.messageId },
    causationId: row.causationId,
    payload: JSON.parse(row.payload),
  });

/**
 * The latest entries that apply to any of `taskIds`, oldest first, at most `limit`, as Diagnostics
 * follows a Quest (ADR 026): order, type, time and IDs, never the payload. A row names no Task, so
 * the payloads that mention one are read and each is kept only when its event applies to it.
 */
export const journalForTasks = (sql: SqlClient.SqlClient, taskIds: ReadonlyArray<string>, limit: number) =>
  Effect.gen(function* () {
    if (taskIds.length === 0) return [];
    const wanted = new Set(taskIds);
    // `_` and `%` match any character in LIKE; the exact check below drops what they let in.
    const mentions = sql.or(taskIds.map((id) => sql`payload LIKE ${`%"${id}"%`}`));
    const rows =
      yield* sql<JournalRow>`SELECT * FROM event_journal WHERE ${mentions} ORDER BY sequence DESC LIMIT ${limit * 2}`;
    const entries: Array<TraceEntry> = [];
    for (const row of rows) {
      if (entries.length >= limit) break;
      const envelope = yield* toEnvelope(row);
      const { taskId } = correlationOf(envelope.payload);
      if (taskId === null || !wanted.has(taskId)) continue;
      entries.push({
        sequence: envelope.sequence,
        type: envelope.type,
        occurredAt: envelope.occurredAt,
        agentId: envelope.correlation.agentId,
        threadId: envelope.correlation.threadId,
        messageId: envelope.correlation.messageId,
        taskId: taskId as TraceEntry["taskId"],
        causationId: envelope.causationId,
      });
    }
    return entries.reverse();
  });

/** Reads and compacts the event journal. Writes go through the repositories, with the change they describe. */
export class EventJournal extends Context.Service<
  EventJournal,
  {
    readonly head: Effect.Effect<JournalHead>;
    /** The oldest sequence still in the journal, or null when it is empty. */
    readonly oldest: Effect.Effect<number | null>;
    /** Committed entries after `sequence`, in sequence order, at most `limit` of them. */
    readonly readAfter: (sequence: number, limit?: number) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
    /** The latest committed entries of the given types, newest first, at most `limit` of them. */
    readonly latestOf: (types: ReadonlyArray<string>, limit: number) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
    /**
     * Deletes entries past retention: older than seven days and outside the latest 10,000, and none
     * that memory capture has still to send (ADR 028). Returns how many it deleted.
     */
    readonly compact: Effect.Effect<number>;
  }
>()("@hobbots/persistence/EventJournal") {
  static readonly layer = Layer.effect(
    EventJournal,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // ISO-8601 times compare byte by byte: SQLite's default, PostgreSQL's "C" collation.
      const occurredAt = sql.onDialectOrElse({
        pg: () => sql.literal(`occurred_at COLLATE "C"`),
        orElse: () => sql.literal("occurred_at"),
      });

      const head = sql<{ readonly epoch: string; readonly sequence: unknown }>`SELECT epoch, sequence
        FROM event_journal_head WHERE id = 1`.pipe(
        Effect.map(([row]) => ({ epoch: String(row?.epoch), sequence: Number(row?.sequence) })),
      );

      const oldest = sql<{ readonly sequence: unknown }>`SELECT MIN(sequence) AS sequence FROM event_journal`.pipe(
        Effect.map(([row]) => (row?.sequence == null ? null : Number(row.sequence))),
      );

      const readAfter = (sequence: number, limit = 1_000) =>
        sql<JournalRow>`SELECT * FROM event_journal WHERE sequence > ${sequence} ORDER BY sequence LIMIT ${limit}`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, toEnvelope)),
        );

      const latestOf = (types: ReadonlyArray<string>, limit: number) =>
        types.length === 0
          ? Effect.succeed([])
          : sql<JournalRow>`SELECT * FROM event_journal WHERE ${sql.in("type", types)}
              ORDER BY sequence DESC LIMIT ${limit}`.pipe(Effect.flatMap((rows) => Effect.forEach(rows, toEnvelope)));

      const compact = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, JOURNAL_RETENTION.age));
        // While memory capture holds its cursor, every entry after it is kept, however old (ADR 028).
        const deleted = yield* sql`DELETE FROM event_journal
          WHERE sequence <= (SELECT sequence FROM event_journal_head WHERE id = 1) - ${JOURNAL_RETENTION.entries}
            AND ${occurredAt} < ${cutoff}
            AND sequence <= COALESCE((SELECT sequence FROM memory_capture WHERE id = 1 AND holding = 1), sequence)
          RETURNING sequence`;
        return deleted.length;
      });

      return EventJournal.of({
        head: head.pipe(Effect.orDie),
        oldest: oldest.pipe(Effect.orDie),
        readAfter: (sequence, limit) => readAfter(sequence, limit).pipe(Effect.orDie),
        latestOf: (types, limit) => latestOf(types, limit).pipe(Effect.orDie),
        compact: compact.pipe(Effect.orDie),
      });
    }),
  );
}
