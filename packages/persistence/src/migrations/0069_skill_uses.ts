import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each use of a skill (ADR 029, The use line, #1096), which the skill's Activity counts and the
// journal records as `SkillUsed`. `skill_id`, `pin` and `number` are null for a skill from your
// organization's settings, and `thread_id` and `message_id` for a use outside a chat, such as a
// Task step's. `explicit` is 1 when you picked the skill for the message.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE skill_uses (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CONSTRAINT skill_uses_source CHECK (source IN ('library', 'organization')),
      skill_id TEXT REFERENCES skills(id),
      name TEXT NOT NULL,
      pin TEXT,
      number INTEGER,
      explicit INTEGER NOT NULL CONSTRAINT skill_uses_explicit_flag CHECK (explicit IN (0, 1)),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      thread_id TEXT,
      message_id TEXT,
      used_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX skill_uses_skill ON skill_uses (skill_id, used_at)`;
  yield* sql`CREATE INDEX skill_uses_agent ON skill_uses (agent_id, used_at)`;
});
