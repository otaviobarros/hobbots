import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Projector cursors (ADR 037, STD-ARCH-016). Each projector reads the event journal after its cursor
// and saves the cursor with what it wrote, in one transaction. Journal compaction keeps every entry
// after the lowest cursor, so a projector that is behind loses nothing. The chapter summary projector
// (#1380) starts at the journal's head: no chapter rests before chapters can be ended.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projector_cursors (
      name TEXT PRIMARY KEY,
      sequence BIGINT NOT NULL
    )
  `;
  yield* sql`INSERT INTO projector_cursors (name, sequence)
    SELECT 'chapter-summaries', sequence FROM event_journal_head WHERE id = 1`;
});
