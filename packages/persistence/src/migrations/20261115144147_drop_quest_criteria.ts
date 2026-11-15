import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A Quest's acceptance criteria are gone (#1588): its lead decides when its "Done when" lines hold, as
// before #1445. Its `acceptance` keeps every line as written, so dropping `criteria` loses no text.
//
// A lead's ask that you waive a required criterion was an ordinary question to you about the Quest's
// top Task, which holds that Task open until it is answered. Nothing is left to waive, so each one
// still open is withdrawn, as a question is when its Task ends. Asked of you, it has no lead's copy
// to settle. It counted once in `needs_you` of each Quest summary whose Task is its Task or above it,
// so each of those counts one less.
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

/** `taskId` and every Task above it, up to the top of its tree. */
const tasksAbove = (sql: SqlClient.SqlClient, taskId: string) =>
  Effect.gen(function* () {
    const ids: Array<string> = [];
    let next: string | null = taskId;
    while (next !== null && !ids.includes(next)) {
      ids.push(next);
      const [row]: ReadonlyArray<{ readonly parent_id: string | null }> = yield* sql<{
        readonly parent_id: string | null;
      }>`SELECT parent_id FROM tasks WHERE id = ${next}`;
      next = row?.parent_id ?? null;
    }
    return ids;
  });

export default Effect.gen(function* () {
  // Read rows by their column names, as the migrator and the hub both see them.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  const quests = yield* sql<{ readonly criteria: string }>`SELECT criteria FROM quests WHERE criteria <> '[]'`;
  const asked = quests.flatMap((quest) => waiverQuestions(quest.criteria));
  const open =
    asked.length === 0
      ? []
      : yield* sql<{ readonly id: string; readonly task_id: string }>`SELECT id, task_id FROM questions
          WHERE state = 'open' AND ${sql.in("id", asked)}`;
  const [head] = yield* sql<{ readonly sequence: unknown }>`SELECT sequence FROM event_journal_head WHERE id = 1`;
  const revision = Number(head?.sequence ?? 0);
  for (const question of open) {
    yield* sql`UPDATE questions SET state = 'withdrawn' WHERE id = ${question.id}`;
    const above = yield* tasksAbove(sql, question.task_id);
    yield* sql`UPDATE quest_summaries SET needs_you = needs_you - 1, revision = ${revision}
      WHERE needs_you > 0 AND ${sql.in("task_id", above)}`;
  }
  yield* sql`ALTER TABLE quests DROP COLUMN criteria`;
  yield* sql`DELETE FROM event_journal WHERE type = 'QuestCriteriaChanged'`;
});
