import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Memory saves (ADR 028). Every `memory_save` to a hob's own memory is recorded, with the key the hob
// sent and journaled, before it is sent, so a retried call returns the first answer and a save made
// while memory is down is kept for the capture worker to send once it is back. `scope` is the work
// the key belongs to, as for the other keyed calls (#660), so a key is free again in the next Task.
// `memory_scope` is the memory it writes, as JSON, and `input` the call's input as stable JSON
// without its key. `id` names the save, so it settles even after its work moved to the Task its
// reply started (#660). The markdown and tags are redacted before they are recorded.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE memory_saves (
        id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        scope TEXT NOT NULL,
        call_key TEXT NOT NULL,
        input TEXT NOT NULL,
        memory_scope TEXT NOT NULL,
        path TEXT NOT NULL,
        markdown TEXT NOT NULL,
        tags TEXT NOT NULL,
        state TEXT NOT NULL CONSTRAINT memory_saves_state_known CHECK (state IN ('sending', 'queued', 'saved', 'refused')),
        version TEXT,
        thread_id TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT memory_saves_key PRIMARY KEY (agent_id, scope, call_key)
      )
    `;
  yield* sql`CREATE INDEX memory_saves_state ON memory_saves (state, created_at)`;
});
