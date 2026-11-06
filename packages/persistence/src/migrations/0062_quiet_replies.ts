import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A lead's reply to work that arrived while its Quest runs, which neither finished the work nor
// brought you a question, is routine progress (#1006): `quiet` is 1 for it, and the chat, the
// thread's last line and its unread dot leave it out. SQLite has no BOOLEAN type, so both databases
// store an INTEGER (ADR 011). Every reply from before is shown, as it was.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0`;
});
