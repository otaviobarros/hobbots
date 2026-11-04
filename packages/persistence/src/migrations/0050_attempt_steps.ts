import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The steps of an Attempt's turns outside any chat, a planned step's or a party member's (#892): its
// tool calls and thinking, as a chat reply keeps them on its message. One row per Attempt holds every
// step of its turns as JSON text, rewritten as they change; a chat turn's steps stay on its reply.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE attempt_steps (
        attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        steps TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
});
