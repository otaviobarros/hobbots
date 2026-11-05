import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What each turn of an Attempt outside any chat used, a planned step's or a party member's (#1011),
// which writes no reply to carry it as a chat turn does (migration 0037). One row per turn, under
// the hob that ran it, its runtime and its model, by when it started. Its four token columns are all
// null when the runtime reported nothing, as for a turn that failed or was stopped.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE attempt_turns (
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        runtime TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL,
        input_tokens BIGINT,
        output_tokens BIGINT,
        cache_read_tokens BIGINT,
        cache_write_tokens BIGINT,
        PRIMARY KEY (attempt_id, started_at)
      )
    `;
  yield* sql`CREATE INDEX attempt_turns_started ON attempt_turns (started_at)`;
});
