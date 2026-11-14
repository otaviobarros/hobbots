import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hob that has nothing to add passes (ADR 039, One hob speaks at a time; #1462).
//
// Its request ends `passed`, a state the table already allows, and keeps the hob's reason in
// `pass_reason`. The reason is written while the request still speaks, as soon as the hob passes, so
// a hub that stops before the turn ends still passes it when it starts again. Every request stored
// before this was never passed, so each reads as having no reason.
//
// A pass leaves no message, but its turn still ran on a runtime: `passed_turns` keeps what the
// removed reply used (OP-002), with its runtime and model, so usage counts it as one more reply,
// and the configuration version it ran on, so a resumed session still hears changed instructions.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE turn_requests ADD COLUMN pass_reason TEXT`;
  yield* sql`CREATE TABLE passed_turns (
    reply_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    agent_id TEXT NOT NULL,
    runtime TEXT,
    model TEXT,
    config_version INTEGER,
    created_at TEXT NOT NULL,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cache_read_tokens BIGINT,
    cache_write_tokens BIGINT
  )`;
  yield* sql`CREATE INDEX passed_turns_created ON passed_turns (created_at)`;
});
