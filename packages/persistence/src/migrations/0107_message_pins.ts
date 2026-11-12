import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Messages you pinned in a chat or camp (ADR 037, #1387), which the camp sheet lists under Mine. A
// pin is keyed by its message alone, so it follows the message when a chapter moves into a camp, and
// goes with it when a queued message is taken back.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE message_pins (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    pinned_at TEXT NOT NULL,
    revision BIGINT NOT NULL
  )`;
});
