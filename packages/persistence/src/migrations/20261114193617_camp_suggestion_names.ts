import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Camps from the right chapter (#1557).
//
// A camp suggestion is raised `pending` now: before it is offered, the hub checks that its chapter
// holds one topic, and names the camp it would make, a `title` and a one-line `goal`. The table is made
// again, since its state's CHECK is part of its definition, with every suggestion kept as it is; the
// ones from before have no name or goal, and Make a camp reads the chapter's own title for them.
//
// The hub starts a chat's chapters on its own when a person's message opens a new topic (ADR 039).
// Its projector reads the journal after its cursor, starting at the journal's head, so it judges the
// messages written from now on.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE camp_suggestions_named (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    chapter_id TEXT NOT NULL,
    reasons TEXT NOT NULL,
    title TEXT,
    goal TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'open', 'kept', 'accepted', 'expired')),
    raised_at TEXT NOT NULL,
    settled_at TEXT,
    camp_id TEXT REFERENCES threads(id),
    revision BIGINT NOT NULL
  )`;
  yield* sql`INSERT INTO camp_suggestions_named
      (id, thread_id, chapter_id, reasons, title, goal, state, raised_at, settled_at, camp_id, revision)
    SELECT id, thread_id, chapter_id, reasons, NULL, NULL, state, raised_at, settled_at, camp_id, revision
    FROM camp_suggestions`;
  yield* sql`DROP TABLE camp_suggestions`;
  yield* sql`ALTER TABLE camp_suggestions_named RENAME TO camp_suggestions`;
  yield* sql`CREATE UNIQUE INDEX camp_suggestions_one_per_chapter ON camp_suggestions (chapter_id)`;
  yield* sql`CREATE INDEX camp_suggestions_thread ON camp_suggestions (thread_id, state)`;

  yield* sql`INSERT INTO projector_cursors (name, sequence)
    SELECT 'chapter-breaks', sequence FROM event_journal_head WHERE id = 1`;
});
