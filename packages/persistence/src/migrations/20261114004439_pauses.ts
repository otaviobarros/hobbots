import { OWNER_ACTOR } from "@hobbots/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// You can pause a Task or a Quest and resume it (#1446). A Task is `pausing` while the turn it was
// paused in still runs, and `paused` once nothing runs; `pause` holds the pause as JSON: the state it
// goes back to, when and by whom, and whether its turn was stopped at once. A Quest is `paused` with
// its Task.
//
// The new states join the sets 0046 and 0110 let the `state` columns take, written out as they stand
// now: a migration never changes. PostgreSQL swaps its named CHECK constraints; SQLite its triggers.
//
// A note names its author (STD-ARCH-019), as JSON: a lead's notes their lead, every other one the
// person a hub served when it was left.
export const TASK_STATES = [
  "queued",
  "active",
  "waiting",
  "blocked",
  "pausing",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;
export const QUEST_STATES = ["active", "paused", "stopping", "completed", "failed", "cancelled", "stopped"] as const;

const widen = (sql: SqlClient.SqlClient, table: string, states: ReadonlyArray<string>) => {
  const list = states.map((state) => `'${state}'`).join(", ");
  const message = `${table}.state must be one of ${states.join(", ")}`;
  return sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_state_known`);
        yield* sql.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_state_known CHECK (state IN (${list}))`);
      }),
    orElse: () =>
      Effect.gen(function* () {
        const abort = `BEGIN SELECT RAISE(ABORT, '${message}'); END`;
        yield* sql.unsafe(`DROP TRIGGER ${table}_state_known_insert`);
        yield* sql.unsafe(`DROP TRIGGER ${table}_state_known_update`);
        yield* sql.unsafe(
          `CREATE TRIGGER ${table}_state_known_insert BEFORE INSERT ON ${table} WHEN NEW.state NOT IN (${list}) ${abort}`,
        );
        yield* sql.unsafe(
          `CREATE TRIGGER ${table}_state_known_update BEFORE UPDATE OF state ON ${table}
            WHEN NEW.state NOT IN (${list}) ${abort}`,
        );
      }),
  });
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE tasks ADD COLUMN pause TEXT`;
  yield* widen(sql, "tasks", TASK_STATES);
  yield* widen(sql, "quests", QUEST_STATES);
  yield* sql`ALTER TABLE task_notes ADD COLUMN author TEXT`;
  yield* sql`UPDATE task_notes SET author = '{"kind":"hob","id":"' || sender_id || '"}' WHERE sender_id IS NOT NULL`;
  yield* sql`UPDATE task_notes SET author = ${JSON.stringify(OWNER_ACTOR)} WHERE sender_id IS NULL`;
});
