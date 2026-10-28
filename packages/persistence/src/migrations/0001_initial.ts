import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL,
        model TEXT,
        instructions TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
  yield* sql`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        title TEXT NOT NULL,
        runtime_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  yield* sql`CREATE INDEX threads_agent_updated ON threads (agent_id, updated_at)`;
  yield* sql`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL
      )
    `;
  yield* sql`CREATE UNIQUE INDEX messages_thread_seq ON messages (thread_id, seq)`;
});
