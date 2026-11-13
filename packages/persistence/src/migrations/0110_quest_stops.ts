import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A Quest's lead can stop it at your request (#1346). The Quest is `stopping` while the work under it
// is cancelled and ends `stopped`, never completed. `stop` holds the stop as JSON: the lead's reason,
// its summary of what was done and when, from `stopping` on; null for every other Quest.
//
// The two states join the set 0046 lets the `state` column take, written out as they stand now: a
// migration never changes. PostgreSQL swaps its named CHECK constraint; SQLite swaps its triggers.
const QUEST_STATES = ["active", "stopping", "completed", "failed", "cancelled", "stopped"] as const;

const list = QUEST_STATES.map((state) => `'${state}'`).join(", ");
const message = `quests.state must be one of ${QUEST_STATES.join(", ")}`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE quests ADD COLUMN stop TEXT`;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql.unsafe("ALTER TABLE quests DROP CONSTRAINT quests_state_known");
        yield* sql.unsafe(`ALTER TABLE quests ADD CONSTRAINT quests_state_known CHECK (state IN (${list}))`);
      }),
    orElse: () =>
      Effect.gen(function* () {
        const abort = `BEGIN SELECT RAISE(ABORT, '${message}'); END`;
        yield* sql.unsafe("DROP TRIGGER quests_state_known_insert");
        yield* sql.unsafe("DROP TRIGGER quests_state_known_update");
        yield* sql.unsafe(
          `CREATE TRIGGER quests_state_known_insert BEFORE INSERT ON quests WHEN NEW.state NOT IN (${list}) ${abort}`,
        );
        yield* sql.unsafe(
          `CREATE TRIGGER quests_state_known_update BEFORE UPDATE OF state ON quests
            WHEN NEW.state NOT IN (${list}) ${abort}`,
        );
      }),
  });
});
