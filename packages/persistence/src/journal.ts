import {
  AgentId,
  type Committed,
  EVENT_SCHEMA_VERSIONS,
  type EventCorrelation,
  EventEnvelope,
  JournaledEvent,
  type JournaledEvent as JournaledEventType,
  ThreadId,
} from "@hobbots/domain";
import { Context, Data, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { recordBackpackItems } from "./backpack-rows.ts";

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
      | "NoteLeft"
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
  if ("note" in event) return { ...NONE, agentId: event.note.recipientId, taskId: event.note.taskId };
  return { ...NONE, taskId: "checkpoint" in event ? event.checkpoint.taskId : event.handOff.toTaskId };
};

const correlationOf = (event: JournaledEventType): RowCorrelation => {
  switch (event._tag) {
    case "AgentUpserted":
      return { ...NONE, agentId: event.agent.id };
    case "ThreadUpserted":
      return { ...NONE, agentId: event.thread.agentId, threadId: event.thread.id };
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
    case "MessageUpserted":
    case "MessageQueued":
      return { ...NONE, threadId: event.message.threadId, messageId: event.message.id };
    default:
      return isTaskEvent(event)
        ? taskCorrelationOf(event)
        : { ...NONE, threadId: event.threadId, messageId: event.messageId };
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
              : sql`COALESCE(${threadId}, (SELECT thread_id FROM tasks WHERE id = ${taskId}))`;
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

// A conditional write found nothing to change; its transaction rolls back, releasing its sequences.
class NothingChanged extends Data.TaggedError("NothingChanged") {}

/**
 * Runs a change in one transaction with the journal sequences its events take, from `first`,
 * reserved before it writes, and appends its events before commit: the journal is the outbox
 * (ADR 013). The backpack items its events call for are recorded in the same transaction, with
 * their own events after the change's (ADR 019). A change that returns null wrote nothing, and rolls back.
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
      // The backpack items the change calls for take the sequences after its own (ADR 019).
      const items = yield* recordBackpackItems(sql, change.events, first + count);
      if (items.length > 0) yield* journal.reserve(items.length);
      return { value: change.value, entries: yield* journal.append(first, [...change.events, ...items]) };
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
      const events = [
        ...change.events,
        ...(yield* recordBackpackItems(sql, change.events, first + change.events.length)),
      ];
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

/** Reads and compacts the event journal. Writes go through the repositories, with the change they describe. */
export class EventJournal extends Context.Service<
  EventJournal,
  {
    readonly head: Effect.Effect<JournalHead>;
    /** The oldest sequence still in the journal, or null when it is empty. */
    readonly oldest: Effect.Effect<number | null>;
    /** Committed entries after `sequence`, in sequence order, at most `limit` of them. */
    readonly readAfter: (sequence: number, limit?: number) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
    /**
     * Deletes entries past retention: older than seven days and outside the latest 10,000. Returns
     * how many it deleted. The journal serves client resume only, so nothing durable depends on them.
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

      const compact = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, JOURNAL_RETENTION.age));
        const deleted = yield* sql`DELETE FROM event_journal
          WHERE sequence <= (SELECT sequence FROM event_journal_head WHERE id = 1) - ${JOURNAL_RETENTION.entries}
            AND ${occurredAt} < ${cutoff}
          RETURNING sequence`;
        return deleted.length;
      });

      return EventJournal.of({
        head: head.pipe(Effect.orDie),
        oldest: oldest.pipe(Effect.orDie),
        readAfter: (sequence, limit) => readAfter(sequence, limit).pipe(Effect.orDie),
        compact: compact.pipe(Effect.orDie),
      });
    }),
  );
}
