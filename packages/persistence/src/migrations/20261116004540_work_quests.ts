import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Quests as work threads (ADR 041, #1596).
//
// One row per Quest a hob starts with `start_work`, beside the Quest of ADR 018, which stays as it is
// until the rollout removes it. A Quest runs in a channel's main line (`root_message_id` null) or in a
// thread, and a conversation runs at most one Quest at a time: the partial unique index holds that
// for the running states, active and waiting, on both databases. `done_when` and `made` are JSON
// arrays of plain lines. Nothing existing is read or rewritten.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_quests (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    root_message_id TEXT,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    done_when TEXT NOT NULL,
    expected_by TEXT,
    owner_hob_id TEXT NOT NULL,
    requested_by_kind TEXT NOT NULL,
    requested_by_id TEXT NOT NULL,
    repository TEXT,
    started_from TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('active', 'waiting', 'done', 'stopped')),
    result TEXT,
    made TEXT NOT NULL,
    finished_from TEXT,
    created_at TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    revision BIGINT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX work_quests_running ON work_quests (channel_id, (COALESCE(root_message_id, '')))
    WHERE state IN ('active', 'waiting')`;
  yield* sql`CREATE INDEX work_quests_channel ON work_quests (channel_id, created_at)`;
});
