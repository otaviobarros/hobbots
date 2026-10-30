import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Editing a hob adds a configuration version instead of overwriting it (AG-002). The agents row
// keeps the current configuration and points at its version; each assistant message records the
// version it ran with. Hobs could not be edited before, so every existing hob and reply is version 1.
// BIGINT holds any look seed on PostgreSQL; SQLite reads it as INTEGER (ADR 011).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE agent_config_versions (
        agent_id TEXT NOT NULL REFERENCES agents(id),
        version INTEGER NOT NULL,
        craft TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        instructions TEXT NOT NULL,
        look_seed BIGINT NOT NULL,
        look_color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, version)
      )
    `;
  yield* sql`
      INSERT INTO agent_config_versions
        (agent_id, version, craft, model, effort, instructions, look_seed, look_color, created_at)
      SELECT id, 1, craft, model, effort, instructions, look_seed, look_color, created_at FROM agents
    `;
  yield* sql`ALTER TABLE agents ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1`;
  yield* sql`ALTER TABLE messages ADD COLUMN config_version INTEGER`;
  yield* sql`UPDATE messages SET config_version = 1 WHERE role = 'assistant'`;
});
