import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The skills a reply used, and the skill you picked for your message (ADR 029, #1096). On a reply,
// `skills_used` is JSON: each skill its turns used, once, with the revision the turn mounted. On your
// message, `asked_skill` is the name you picked with `/`. Null for messages from before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE messages ADD COLUMN skills_used TEXT`;
  yield* sql`ALTER TABLE messages ADD COLUMN asked_skill TEXT`;
});
