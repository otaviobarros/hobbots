import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The hobs and people each message @mentions (ADR 039, Who answers; #1455), as JSON: the actors in
// the order first mentioned, each once. The hub parses a message's text once, when it stores its
// final text, so who answers and who is told read the same list. Messages from before mention nobody.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'`;
});
