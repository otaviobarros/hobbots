import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Questions the hub itself puts to you (#976). A hub question has no Task and no asking hob: it is
// about a subject the hub names (`subject_kind` names the part of the hub that applies the answer,
// `subject_key` which thing of that kind), and may name the chat it concerns. Its choices are JSON
// text as a hob's question keeps them (0054). `applied_at` is set once the hub applied your answer,
// so an answer the hub could not apply yet is applied when it starts again.
//
// The state set is written out as it stands now, as 0046 does for `questions`: a later state needs
// a migration of its own.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE hub_questions (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      subject_title TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id),
      thread_id TEXT REFERENCES threads(id),
      text TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]',
      recommended INTEGER,
      state TEXT NOT NULL CONSTRAINT hub_questions_state_known CHECK (state IN ('open', 'answered', 'withdrawn')),
      answer TEXT,
      picked INTEGER,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      answered_by_device_id TEXT,
      answered_via TEXT,
      applied_at TEXT,
      revision BIGINT NOT NULL DEFAULT 0
    )
  `;
  yield* sql`CREATE INDEX hub_questions_subject ON hub_questions (subject_kind, subject_key, state)`;
});
