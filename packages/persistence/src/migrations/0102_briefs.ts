import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Camp briefs (ADR 037, Records, #1384): one "Where we are" per chat or camp, written by the brief
// projector, never by a hob turn. Each row keeps the journal sequence its text was written from
// (`basis`), so a replayed page never writes it again. The projector's cursor joins 0100's
// `projector_cursors` at the journal's head: a thread gets its first brief at its next chapter end
// or Quest step.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE briefs (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id),
      text TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('brain', 'rule')),
      basis BIGINT NOT NULL,
      written_at TEXT NOT NULL,
      revision BIGINT NOT NULL
    )
  `;
  yield* sql`INSERT INTO projector_cursors (name, sequence)
    SELECT 'camp-briefs', sequence FROM event_journal_head WHERE id = 1`;
});
