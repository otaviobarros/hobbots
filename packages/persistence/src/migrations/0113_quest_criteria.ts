import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A Quest's acceptance criteria are checked against evidence (#1445). `criteria` holds them as JSON,
// in order: each with its id, its text, whether it is required, the Tasks linked to it, its state,
// the artifact versions it was accepted on and its last decision. Every Quest stored before keeps its
// acceptance as it was written, and gains one required criterion for each line, none checked yet.
// Nothing is journaled for them: a Quest journaled before decodes with no criteria.

interface QuestRow {
  readonly id: string;
  readonly acceptance: string;
}

const criteriaOf = (acceptance: string) => {
  const lines: unknown = JSON.parse(acceptance);
  return (Array.isArray(lines) ? lines : []).map((text) => ({
    id: crypto.randomUUID(),
    text: String(text),
    required: true,
    taskIds: [],
    state: "open",
    evidence: [],
    decided: null,
  }));
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE quests ADD COLUMN criteria TEXT NOT NULL DEFAULT '[]'`;
  const quests = yield* sql<QuestRow>`SELECT id, acceptance FROM quests WHERE acceptance <> '[]'`;
  for (const quest of quests) {
    yield* sql`UPDATE quests SET criteria = ${JSON.stringify(criteriaOf(quest.acceptance))} WHERE id = ${quest.id}`;
  }
});
