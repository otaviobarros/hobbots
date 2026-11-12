import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Camp suggestions and moving a chapter into a camp (ADR 037, #1385).
//
// A chat's chapter gets at most one suggestion, held by a unique index on its chapter, so one you
// kept in the chat is never raised again. Its reasons are codes and counts, kept as JSON. A
// suggestion outlives a chapter merged away, which expires it, so its chapter is not a reference.
//
// A top Task started in a chat or camp now names the chapter it was started in, so moving that
// chapter takes the quests started in it. Each Task stored before gets the chapter of its thread
// that had started when it was made, or the thread's first.
//
// The camp drift projector reads the journal after its cursor, starting at the journal's head, so it
// judges the chapters that come to rest from now on.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE camp_suggestions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    chapter_id TEXT NOT NULL,
    reasons TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'kept', 'accepted', 'expired')),
    raised_at TEXT NOT NULL,
    settled_at TEXT,
    camp_id TEXT REFERENCES threads(id),
    revision BIGINT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX camp_suggestions_one_per_chapter ON camp_suggestions (chapter_id)`;
  yield* sql`CREATE INDEX camp_suggestions_thread ON camp_suggestions (thread_id, state)`;

  yield* sql`ALTER TABLE tasks ADD COLUMN chapter_id TEXT REFERENCES chapters(id)`;
  yield* sql`UPDATE tasks SET chapter_id = COALESCE(
      (SELECT c.id FROM chapters c WHERE c.thread_id = tasks.thread_id AND c.started_at <= tasks.created_at
        ORDER BY c.number DESC LIMIT 1),
      (SELECT c.id FROM chapters c WHERE c.thread_id = tasks.thread_id ORDER BY c.number LIMIT 1))
    WHERE parent_id IS NULL AND thread_id IS NOT NULL`;
  yield* sql`CREATE INDEX tasks_chapter ON tasks (chapter_id)`;

  yield* sql`INSERT INTO projector_cursors (name, sequence)
    SELECT 'camp-drift', sequence FROM event_journal_head WHERE id = 1`;
});
