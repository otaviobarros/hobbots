import {
  AgentId,
  type Committed,
  EVENT_SCHEMA_VERSIONS,
  type EventCorrelation,
  EventEnvelope,
  JournaledEvent,
  type JournaledEvent as JournaledEventType,
} from "@hobbots/domain";
import { Context, Data, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** Where the journal stands: its epoch (new for every fresh database) and the last committed sequence. */
export interface JournalHead {
  readonly epoch: string;
  readonly sequence: number;
}

/** How long entries are kept, and how many of the latest are always kept, whichever retains more (ADR 013). */
export const JOURNAL_RETENTION = { age: Duration.days(7), entries: 10_000 } as const;

const encodePayload = Schema.encodeSync(JournaledEvent);
const decodeEnvelope = Schema.decodeUnknownEffect(EventEnvelope);

const correlationOf = (event: JournaledEventType): EventCorrelation => {
  switch (event._tag) {
    case "AgentUpserted":
      return { agentId: event.agent.id, threadId: null, messageId: null };
    case "ThreadUpserted":
      return { agentId: event.thread.agentId, threadId: event.thread.id, messageId: null };
    case "ApprovalRequested":
    case "ApprovalResolved":
      return {
        agentId: event.approval.agentId,
        threadId: event.approval.threadId,
        messageId: event.approval.messageId,
      };
    case "MessageUpserted":
    case "MessageQueued":
      return { agentId: null, threadId: event.message.threadId, messageId: event.message.id };
    default:
      return { agentId: null, threadId: event.threadId, messageId: event.messageId };
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
          const { agentId, threadId, messageId } = correlationOf(payload);
          const [row] = yield* sql<{ readonly agentId: string | null }>`INSERT INTO event_journal
              (sequence, id, type, schema_version, occurred_at, agent_id, thread_id, message_id, causation_id, payload)
            VALUES (
              ${sequence}, ${id}, ${type}, ${schemaVersion}, ${occurredAt},
              COALESCE(${agentId}, (SELECT agent_id FROM threads WHERE id = ${threadId})),
              ${threadId}, ${messageId}, NULL, ${JSON.stringify(encodePayload(payload))}
            )
            RETURNING agent_id`;
          return new EventEnvelope({
            id,
            sequence,
            schemaVersion,
            type,
            occurredAt,
            correlation: { agentId: row?.agentId == null ? null : AgentId.make(row.agentId), threadId, messageId },
            causationId: null,
            payload,
          });
        }),
      );
    });

  return { reserve, append };
};

// A conditional write found nothing to change; its transaction rolls back, releasing its sequences.
class NothingChanged extends Data.TaggedError("NothingChanged") {}

/**
 * Runs a change in one transaction with the journal sequences its events take, from `first`,
 * reserved before it writes, and appends its events before commit: the journal is the outbox
 * (ADR 013). A change that returns null wrote nothing, and rolls back.
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
      return { value: change.value, entries: yield* journal.append(first, change.events) };
    }).pipe(
      sql.withTransaction,
      Effect.map(Option.some),
      Effect.catchTag("NothingChanged", () => Effect.succeed(Option.none())),
      Effect.orDie,
    );
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
