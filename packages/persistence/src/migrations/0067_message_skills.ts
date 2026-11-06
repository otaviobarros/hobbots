import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The skills of a turn, as JSON (ADR 029, #1061): on your message, those it was given when the hub
// accepted it, so a queued message keeps them through a rollout; on a reply, those its latest turn
// used. Null for messages from before, and on a hub without a skills library.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN skills TEXT`;
});
