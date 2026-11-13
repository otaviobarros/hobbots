import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The people the hub serves (ADR 039, Users as actors; #1451). Every record you wrote names you as the
// actor `{ kind: "user", id: "owner" }`, so the owner becomes the user `owner` and each stored actor
// keeps its meaning. Setup never asked for a name, so the owner is named "Owner" until a person can set
// their own. `state` is only `active` until the accounts design adds more; PostgreSQL refuses any other
// with a named CHECK constraint, SQLite with triggers, written out as they stand now.
export const USER_STATES = ["active"] as const;

const list = USER_STATES.map((state) => `'${state}'`).join(", ");
const message = `users.state must be one of ${USER_STATES.join(", ")}`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    initials TEXT NOT NULL,
    color TEXT NOT NULL,
    state TEXT NOT NULL
  )`;
  yield* sql.onDialectOrElse({
    pg: () => sql.unsafe(`ALTER TABLE users ADD CONSTRAINT users_state_known CHECK (state IN (${list}))`),
    orElse: () =>
      Effect.gen(function* () {
        const abort = `BEGIN SELECT RAISE(ABORT, '${message}'); END`;
        yield* sql.unsafe(
          `CREATE TRIGGER users_state_known_insert BEFORE INSERT ON users WHEN NEW.state NOT IN (${list}) ${abort}`,
        );
        yield* sql.unsafe(
          `CREATE TRIGGER users_state_known_update BEFORE UPDATE OF state ON users
            WHEN NEW.state NOT IN (${list}) ${abort}`,
        );
      }),
  });
  yield* sql`INSERT INTO users (id, name, initials, color, state) VALUES ('owner', 'Owner', 'O', 'amber', 'active')`;
});
