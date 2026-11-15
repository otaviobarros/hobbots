import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A Quest's acceptance criteria are gone (#1588): its lead decides when its "Done when" lines hold, as
// before #1445. Its `acceptance` keeps every line as written, so dropping `criteria` loses no text.
//
// A lead's ask that you waive a required criterion was an ordinary question to you about the Quest's
// top Task, which holds that Task open until it is answered. Nothing is left to waive, so each one
// still open is withdrawn, as a question is when its Task ends. Asked of you, it has no lead's copy
// to settle.
//
// No event type `QuestCriteriaChanged` is left to decode the journaled ones, so they go too. A Quest
// in any other entry still carries the `criteria` it was journaled with, which decoding ignores.

/** The questions a Quest's criteria name as asks to waive them, from its stored JSON. */
const waiverQuestions = (criteria: string): ReadonlyArray<string> => {
  const parsed: unknown = JSON.parse(criteria);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((criterion: { readonly waiverAsk?: { readonly questionId?: unknown } | null }) => {
    const id = criterion?.waiverAsk?.questionId;
    return typeof id === "string" ? [id] : [];
  });
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const quests = yield* sql<{ readonly criteria: string }>`SELECT criteria FROM quests WHERE criteria <> '[]'`;
  const asked = quests.flatMap((quest) => waiverQuestions(quest.criteria));
  if (asked.length > 0) {
    yield* sql`UPDATE questions SET state = 'withdrawn' WHERE state = 'open' AND ${sql.in("id", asked)}`;
  }
  yield* sql`ALTER TABLE quests DROP COLUMN criteria`;
  yield* sql`DELETE FROM event_journal WHERE type = 'QuestCriteriaChanged'`;
});
