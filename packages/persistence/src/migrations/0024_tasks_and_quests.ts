import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Tasks and Quests (ADR 018). Every piece of work is a Task with an owner hob, a parent (null for
// the Task the user asked for) and a root (itself for that Task). `depends_on` lists sibling Tasks
// in the same tree as JSON text. A Quest sits on exactly one Task (`task_id` is unique). A retry is
// a new row in `attempts`, numbered per Task, never a new Task. A Task's result names its Attempt.
//
// Ids are text, times ISO 8601 text and JSON text, as elsewhere. `revision` is the journal sequence
// of the change that last wrote the row (ADR 013), a bigint on PostgreSQL. SQLite does not check
// foreign keys here, so the repository checks lineage itself; the references document it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES agents(id),
        parent_id TEXT REFERENCES tasks(id),
        root_id TEXT NOT NULL,
        thread_id TEXT REFERENCES threads(id),
        brief TEXT NOT NULL,
        state TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        result_summary TEXT,
        result_attempt_id TEXT,
        current_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
  yield* sql`CREATE INDEX tasks_root ON tasks (root_id)`;
  yield* sql`CREATE INDEX tasks_parent ON tasks (parent_id)`;
  yield* sql`CREATE INDEX tasks_owner ON tasks (owner_id, state)`;
  yield* sql`
      CREATE TABLE quests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        lead_id TEXT NOT NULL REFERENCES agents(id),
        parent_quest_id TEXT REFERENCES quests(id),
        thread_id TEXT REFERENCES threads(id),
        goal TEXT NOT NULL,
        acceptance TEXT NOT NULL DEFAULT '[]',
        limits TEXT NOT NULL,
        depth INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ended_at TEXT,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
  yield* sql`
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY,
        quest_id TEXT NOT NULL REFERENCES quests(id),
        lead_id TEXT NOT NULL REFERENCES agents(id),
        member_id TEXT NOT NULL REFERENCES agents(id),
        parent_task_id TEXT NOT NULL REFERENCES tasks(id),
        child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        brief TEXT NOT NULL,
        expected_output TEXT,
        authority TEXT NOT NULL,
        timeout_ms BIGINT,
        created_at TEXT NOT NULL
      )
    `;
  yield* sql`CREATE INDEX delegations_quest ON delegations (quest_id)`;
  yield* sql`
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        number INTEGER NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        runtime TEXT NOT NULL,
        session_id TEXT,
        config_version INTEGER NOT NULL,
        policy_version TEXT,
        state TEXT NOT NULL,
        outcome TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE (task_id, number)
      )
    `;
  yield* sql`
      CREATE TABLE milestones (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        reached_at TEXT,
        created_at TEXT NOT NULL
      )
    `;
  yield* sql`CREATE INDEX milestones_task ON milestones (task_id)`;
  yield* sql`
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT REFERENCES attempts(id),
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        milestone_id TEXT REFERENCES milestones(id),
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
  yield* sql`CREATE INDEX checkpoints_task ON checkpoints (task_id, revision)`;
  yield* sql`
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        asker_id TEXT NOT NULL REFERENCES agents(id),
        recipient_id TEXT REFERENCES agents(id),
        chain TEXT NOT NULL DEFAULT '[]',
        text TEXT NOT NULL,
        state TEXT NOT NULL,
        answer TEXT,
        answered_by TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        revision BIGINT NOT NULL DEFAULT 0
      )
    `;
  yield* sql`CREATE INDEX questions_task ON questions (task_id, state)`;
  yield* sql`
      CREATE TABLE artifact_refs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
  yield* sql`CREATE INDEX artifact_refs_task ON artifact_refs (task_id)`;
  yield* sql`
      CREATE TABLE hand_offs (
        artifact_id TEXT NOT NULL REFERENCES artifact_refs(id),
        to_task_id TEXT NOT NULL REFERENCES tasks(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (artifact_id, to_task_id)
      )
    `;
});
