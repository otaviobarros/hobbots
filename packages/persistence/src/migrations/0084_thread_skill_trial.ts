import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The draft a chat tries (ADR 029, Try in a chat, #1099), as JSON, or null for an ordinary chat.
// Every existing thread is an ordinary chat.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN skill_trial TEXT`;
});
