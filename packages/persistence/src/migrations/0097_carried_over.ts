import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What Start fresh carried from a chat into the one that replaced it (ADR 037, #1376): one row per
// thing, written once in the transaction that moved it. `ref_kind` is `task`, `question`, `reminder`
// or `backpack-item`, and `ref_id` the id it names. The primary key keeps a thing from being carried
// out of the same chat twice; the index finds what a new chat carries for its first turn.
//
// `camp_requests` keeps what Make a camp was asked, under its key, as it was asked. The camp's own
// title can be renamed later, so the same request sent again is checked against this row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE carried_over (
      from_thread_id TEXT NOT NULL REFERENCES threads(id),
      to_thread_id TEXT NOT NULL REFERENCES threads(id),
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      label TEXT NOT NULL,
      position INTEGER NOT NULL,
      carried_at TEXT NOT NULL,
      PRIMARY KEY (from_thread_id, ref_kind, ref_id)
    )
  `;
  yield* sql`CREATE INDEX carried_over_to ON carried_over (to_thread_id, position)`;
  yield* sql`
    CREATE TABLE camp_requests (
      key TEXT PRIMARY KEY REFERENCES threads(id),
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT,
      private INTEGER NOT NULL
    )
  `;
});
