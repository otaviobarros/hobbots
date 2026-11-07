import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// What hobs suggest for the skills library (ADR 029, Proactive hobs), beside it and never in it.
// A proposal is keyed by hob, work and key, as memory saves are (`scope`, `call_key`, `input` hold
// the work and the SHA-256 of the key and of the input). `skill_id` and `base_hash`/`base_number`
// name the skill and revision a change was made against, and are null for a new skill;
// `added_hash`/`added_number` the revision it became, and `added_as` whether it was new, the newest
// already, or an earlier one brought back. `planned_hash`/`planned_after`/`planned_as` are what an
// add in progress writes, recorded before it writes anything, so a stopped hub finishes that. `memory_pages` is JSON, and `edited` is 0 or
// 1. A hob has at most one proposal per name open at once. Feedback is a hob's note on a skill.
// `skill_operations` holds a receipt for each change an approved proposal made to who uses a skill,
// written in the transaction that made it, so making it again after a stop moves nothing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE skill_proposals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      scope TEXT NOT NULL,
      call_key TEXT NOT NULL,
      input TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      skill_id TEXT REFERENCES skills(id),
      base_hash TEXT,
      base_number INTEGER,
      instructions TEXT NOT NULL,
      why TEXT NOT NULL,
      state TEXT NOT NULL,
      edited INTEGER NOT NULL CONSTRAINT skill_proposals_edited_flag CHECK (edited IN (0, 1)),
      added_hash TEXT,
      added_number INTEGER,
      added_as TEXT,
      planned_hash TEXT,
      planned_after TEXT,
      planned_as TEXT,
      memory_pages TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      attempt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT
    )
  `;
  yield* sql`CREATE UNIQUE INDEX skill_proposals_key ON skill_proposals (agent_id, scope, call_key)`;
  yield* sql`
    CREATE UNIQUE INDEX skill_proposals_open_name ON skill_proposals (agent_id, name)
    WHERE state IN ('waiting', 'adding')
  `;
  yield* sql`
    CREATE TABLE skill_feedback (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      kind TEXT NOT NULL,
      note TEXT NOT NULL,
      revision TEXT,
      thread_id TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX skill_feedback_skill ON skill_feedback (skill_id, created_at)`;
  yield* sql`
    CREATE TABLE skill_operations (
      operation TEXT PRIMARY KEY,
      done_at TEXT NOT NULL
    )
  `;
});
