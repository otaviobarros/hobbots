import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// How far you have read each thread (ADR 027, #910): the `seq` of the last message you read, so a
// thread's unread state holds across every device on the hub. A thread from before this counts as
// read through its last message, so upgrading marks nothing unread.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN read_seq INTEGER`;
  yield* sql`UPDATE threads SET read_seq = (SELECT MAX(seq) FROM messages WHERE messages.thread_id = threads.id)`;
});
