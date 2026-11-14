import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The hobs and people each message @mentions (ADR 039, Who answers; #1455), as JSON: the actors in
// the order first mentioned, each once. The hub parses a message's text once, when it stores its
// final text, so who answers and who is told read the same list. Messages from before mention nobody.
// `mentions_through` is how much of the text was parsed, in UTF-16 code units: a reply continued with
// Continue grows past it, and only the text past it is read again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE messages ADD COLUMN mentions_through BIGINT NOT NULL DEFAULT 0`;
});
