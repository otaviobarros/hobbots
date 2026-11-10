import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Who wrote each memory version the hub sent (#1317): ai-memory names a version's author only for its
// own registered users, so the hub keeps it, by the engine's version id, with the page it belongs to
// (`memoryScopeKey` and path) so a forget drops a page's rows with its history. `author` is a
// `MemoryAuthor` as JSON text.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE memory_version_authors (
      version TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      path TEXT NOT NULL,
      author TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX memory_version_authors_page ON memory_version_authors (scope, path)`;
});
