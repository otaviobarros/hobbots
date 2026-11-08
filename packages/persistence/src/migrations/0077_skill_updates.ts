import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Updates from a source (ADR 029). A check of a skill's Git source records what it found upstream in
// `skill_updates`, one row per skill, beside the library and never inside it: the content's `hash`,
// the newest revision it was compared with (`base`), and its review (`files`, `instructions` and
// `flags`, as JSON). `state` is `waiting`, or `dismissed` after Not now. A skill set to Update
// automatically has a row in `skill_auto_updates`. `skill_update_checks` keeps the last check, in its
// one row: when it ran, and the sources it could not read, as JSON.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE skill_updates (
      skill_id TEXT PRIMARY KEY REFERENCES skills(id),
      name TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES skill_sources(id),
      base TEXT NOT NULL,
      base_number INTEGER NOT NULL,
      hash TEXT NOT NULL,
      commit_sha TEXT,
      label TEXT,
      path TEXT,
      files TEXT NOT NULL,
      instructions TEXT NOT NULL,
      flags TEXT NOT NULL,
      state TEXT NOT NULL CONSTRAINT skill_updates_state CHECK (state IN ('waiting', 'dismissed')),
      found_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE skill_auto_updates (
      skill_id TEXT PRIMARY KEY REFERENCES skills(id),
      turned_on_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE skill_update_checks (
      id INTEGER PRIMARY KEY CONSTRAINT skill_update_checks_one CHECK (id = 1),
      checked_at TEXT NOT NULL,
      problems TEXT NOT NULL
    )
  `;
});
