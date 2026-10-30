import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The durable event journal (ADR 013). Each state change appends its events here in its own
// transaction, so the journal is also the outbox. The head row holds the journal's epoch and the
// last sequence handed out: incrementing it inside the writing transaction keeps sequences unique,
// gap-free and in commit order on SQLite and PostgreSQL alike, which an identity column is not.
// Agents, threads and messages carry the sequence of the change that last wrote them as their revision.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE event_journal_head (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch TEXT NOT NULL,
        sequence BIGINT NOT NULL
      )
    `;
  yield* sql`INSERT INTO event_journal_head ${sql.insert({ id: 1, epoch: randomUUID(), sequence: 0 })}`;
  yield* sql`
      CREATE TABLE event_journal (
        sequence BIGINT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        agent_id TEXT,
        thread_id TEXT,
        message_id TEXT,
        causation_id TEXT,
        payload TEXT NOT NULL
      )
    `;
  // Rows written before the journal existed have no revision yet.
  yield* sql`ALTER TABLE agents ADD COLUMN revision BIGINT NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE threads ADD COLUMN revision BIGINT NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE messages ADD COLUMN revision BIGINT NOT NULL DEFAULT 0`;
});
