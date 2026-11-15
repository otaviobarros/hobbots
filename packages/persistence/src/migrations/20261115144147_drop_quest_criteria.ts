import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A Quest's acceptance criteria are gone (#1588): its lead decides when its "Done when" lines hold, as
// before #1445. Its `acceptance` keeps every line as written, so dropping `criteria` loses no text.
// No event type `QuestCriteriaChanged` is left to decode the journaled ones, so they go too. A Quest
// in any other entry still carries the `criteria` it was journaled with, which decoding ignores.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE quests DROP COLUMN criteria`;
  yield* sql`DELETE FROM event_journal WHERE type = 'QuestCriteriaChanged'`;
});
