import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Undoing a hob's save from its reply (ADR 028, #961). `undone_at` is when you undid it, which put
// back the version it replaced or, for a page it made, removed the page; null while it stands. A chat
// lists the saves of its replies, so they are found by thread.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_saves ADD COLUMN undone_at TEXT`;
  yield* sql`CREATE INDEX memory_saves_thread ON memory_saves (thread_id, created_at)`;
});
