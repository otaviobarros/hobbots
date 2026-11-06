import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The skills library (ADR 029, Storage and revisions). A skill keeps its id across revisions; its
// name is unique among the skills not removed, and a removed skill keeps its rows, in the Archive,
// with `removed_at` set. A revision is named by the SHA-256 of its content and never changes: its
// files live outside the database, once per hash, and `files`, `flags`, `dropped`, `charms` and
// `added_by` are JSON. `number` is its place in the skill's history (r1, r2). A source is recorded
// once per origin (`origin_key`), and `origin` is its JSON. An assignment pins a skill to one of its
// revisions in one scope (`scope` as JSON, `scope_key` to keep one per skill and scope); `held` and
// `only_when_asked` are 0 or 1. An opt-out turns an Everyone or Project skill off for one hob.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE skill_sources (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      origin_key TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      latest TEXT NOT NULL,
      revisions INTEGER NOT NULL,
      source_id TEXT REFERENCES skill_sources(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      removed_at TEXT,
      revision BIGINT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX skills_name ON skills (name) WHERE removed_at IS NULL`;
  yield* sql`
    CREATE TABLE skill_revisions (
      skill_id TEXT NOT NULL REFERENCES skills(id),
      hash TEXT NOT NULL,
      number INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      charms TEXT NOT NULL,
      files TEXT NOT NULL,
      flags TEXT NOT NULL,
      dropped TEXT NOT NULL,
      source_id TEXT REFERENCES skill_sources(id),
      commit_sha TEXT,
      path TEXT,
      label TEXT,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      CONSTRAINT skill_revisions_key PRIMARY KEY (skill_id, hash),
      CONSTRAINT skill_revisions_number UNIQUE (skill_id, number)
    )
  `;
  yield* sql`
    CREATE TABLE skill_assignments (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES skills(id),
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      pin TEXT NOT NULL,
      held INTEGER NOT NULL CONSTRAINT skill_assignments_held_flag CHECK (held IN (0, 1)),
      only_when_asked INTEGER NOT NULL CONSTRAINT skill_assignments_only_when_asked_flag CHECK (only_when_asked IN (0, 1)),
      assigned_by TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      revision BIGINT NOT NULL,
      CONSTRAINT skill_assignments_scope UNIQUE (skill_id, scope_key),
      CONSTRAINT skill_assignments_pin FOREIGN KEY (skill_id, pin) REFERENCES skill_revisions(skill_id, hash)
    )
  `;
  yield* sql`
    CREATE TABLE skill_opt_outs (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      opted_out_at TEXT NOT NULL,
      CONSTRAINT skill_opt_outs_key PRIMARY KEY (agent_id, skill_id)
    )
  `;
});
