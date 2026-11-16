import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Reply threads (ADR 039, #1484): a message replying in a thread names its root, the message the
// thread hangs from, and `also_in_main_line` is 1 when it was also sent to the channel's main line.
// SQLite has no BOOLEAN type, so both databases store an INTEGER (ADR 011). Every message from before
// is in the main line, as it was: no root, and not also sent. The index finds a root's replies.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN root_message_id TEXT`;
  yield* sql`ALTER TABLE messages ADD COLUMN also_in_main_line INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE INDEX messages_root ON messages (root_message_id)`;
});
