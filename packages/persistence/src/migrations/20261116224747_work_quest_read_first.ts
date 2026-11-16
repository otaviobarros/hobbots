import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What a Quest's owner read first (ADR 039, Asking for a delivery in a shared camp; #1487), as JSON:
// the records the pack its session started from carried, from that pack's `PackReport`, which the
// Quest's card lists as "Read first". Quests started before list nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE work_quests ADD COLUMN read_first TEXT NOT NULL DEFAULT '[]'`;
});
