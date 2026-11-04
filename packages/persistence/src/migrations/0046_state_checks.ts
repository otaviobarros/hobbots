import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The state of a Task, an Attempt, a Quest and a question is one of a fixed set (ADR 018), and
// until now only the domain schema refused any other (#683). Each `state` column now refuses it
// too, so a raw UPDATE or a hand edit can no longer store a state no reader can decode.
//
// The sets are written out here, as they stood when this migration was written: a migration
// never changes. A later state needs a migration of its own, which `state-checks.test.ts` asks for.
//
// PostgreSQL adds a named CHECK constraint. SQLite cannot add one to a table it already has, and
// rebuilding `tasks` would rewrite every table that refers to it, so it gets triggers that abort
// an insert or an update of `state` with the same message. A stored row whose state is outside its
// set stops the migration first, naming it, rather than leaving a constraint the data breaks.
export const STATES = {
  tasks: ["queued", "active", "waiting", "blocked", "cancelling", "completed", "failed", "cancelled"],
  attempts: ["starting", "running", "completed", "failed", "interrupted", "cancelled", "unresolved"],
  quests: ["active", "completed", "failed", "cancelled"],
  questions: ["open", "answered", "withdrawn"],
} as const;

/** The states as an SQL list, quoted; they hold only lowercase letters. */
const listOf = (states: ReadonlyArray<string>) => states.map((state) => `'${state}'`).join(", ");

const message = (table: string, states: ReadonlyArray<string>) => `${table}.state must be one of ${states.join(", ")}`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, states] of Object.entries(STATES)) {
    const list = listOf(states);
    const stray = yield* sql.unsafe<{ readonly id: string; readonly state: string }>(
      `SELECT id, state FROM ${table} WHERE state NOT IN (${list}) LIMIT 1`,
    );
    const [first] = stray;
    if (first !== undefined) {
      return yield* Effect.die(
        new Error(`${table} ${first.id} holds the state "${first.state}". ${message(table, states)}.`),
      );
    }
    yield* sql.onDialectOrElse({
      pg: () => sql.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_state_known CHECK (state IN (${list}))`),
      orElse: () =>
        Effect.gen(function* () {
          const abort = `BEGIN SELECT RAISE(ABORT, '${message(table, states)}'); END`;
          yield* sql.unsafe(
            `CREATE TRIGGER ${table}_state_known_insert BEFORE INSERT ON ${table}
              WHEN NEW.state NOT IN (${list}) ${abort}`,
          );
          yield* sql.unsafe(
            `CREATE TRIGGER ${table}_state_known_update BEFORE UPDATE OF state ON ${table}
              WHEN NEW.state NOT IN (${list}) ${abort}`,
          );
        }),
    });
  }
});
