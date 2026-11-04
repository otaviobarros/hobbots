import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// How far you have read each thread (ADR 027, #910): the newest message revision you have seen in
// it, so a thread's unread state holds across every device on the hub, and a reply continued in
// place after you read it is new again. A thread from before this counts as read through its last
// message, so upgrading marks nothing unread.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN read_revision BIGINT`;
  yield* sql`UPDATE threads SET read_revision = (SELECT MAX(revision) FROM messages WHERE messages.thread_id = threads.id)`;
});
