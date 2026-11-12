import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The find index (ADR 037, Records, #1386): every chat's and camp's decisions, artifacts and
// chapters, one row each, in `find_records`, kept by the find projector from the journal after its
// cursor. A row is where its record is now: its thread, its chapter and the message a citation
// opens; a chapter's is its first message, read when it is found, since it gets one only later. `body` is the text find matches: a decision's words, an artifact's title and where it is,
// a chapter's title and summary. `indexed_sequence` is the journal entry the row was written from.
//
// Like the messages' index (0011), each dialect keeps its words index current in the statement
// that writes a row: SQLite through an FTS5 table kept by triggers, on the row's own integer key so
// a VACUUM never renumbers it, and PostgreSQL through a GIN expression index.
//
// The projector starts at the journal's head, so the rows of the records stored before it are
// written here, as the projector writes a thread's rows.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = `
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'artifact', 'chapter')),
    record_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    message_id TEXT,
    title TEXT,
    detail TEXT,
    body TEXT NOT NULL,
    state TEXT,
    artifact_kind TEXT,
    version INTEGER,
    number INTEGER,
    actor_kind TEXT,
    actor_id TEXT,
    at TEXT NOT NULL,
    indexed_sequence BIGINT NOT NULL,
    UNIQUE (kind, record_id)`;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE TABLE find_records (seq BIGSERIAL PRIMARY KEY, ${columns})`);
        yield* sql`CREATE INDEX find_records_body ON find_records USING GIN (to_tsvector('simple', body))`;
      }),
    orElse: () =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE TABLE find_records (seq INTEGER PRIMARY KEY, ${columns})`);
        yield* sql`CREATE VIRTUAL TABLE find_search USING fts5(
          body, content = 'find_records', content_rowid = 'seq', tokenize = 'unicode61 remove_diacritics 2'
        )`;
        yield* sql`CREATE TRIGGER find_search_insert AFTER INSERT ON find_records BEGIN
          INSERT INTO find_search (rowid, body) VALUES (new.seq, new.body);
        END`;
        yield* sql`CREATE TRIGGER find_search_update AFTER UPDATE OF body ON find_records BEGIN
          INSERT INTO find_search (find_search, rowid, body) VALUES ('delete', old.seq, old.body);
          INSERT INTO find_search (rowid, body) VALUES (new.seq, new.body);
        END`;
        yield* sql`CREATE TRIGGER find_search_delete AFTER DELETE ON find_records BEGIN
          INSERT INTO find_search (find_search, rowid, body) VALUES ('delete', old.seq, old.body);
        END`;
      }),
  });
  yield* sql`CREATE INDEX find_records_thread ON find_records (thread_id, at)`;

  const [head] = yield* sql<{ sequence: unknown }>`SELECT sequence FROM event_journal_head WHERE id = 1`;
  const sequence = Number(head?.sequence ?? 0);
  yield* sql`INSERT INTO projector_cursors (name, sequence) VALUES ('find-index', ${sequence})`;

  // Fixed here rather than shared with the projector, so this migration never changes after it runs.
  yield* sql`INSERT INTO find_records (kind, record_id, thread_id, chapter_id, message_id, title, body, state,
      actor_kind, actor_id, at, indexed_sequence)
    SELECT 'decision', id, thread_id, chapter_id, source_message_id, text, text, state, actor_kind, actor_id,
      recorded_at, CAST(${sequence} AS BIGINT)
    FROM decisions`;
  yield* sql`INSERT INTO find_records (kind, record_id, thread_id, chapter_id, message_id, title, detail, body,
      artifact_kind, version, actor_kind, actor_id, at, indexed_sequence)
    SELECT 'artifact', id, thread_id, chapter_id, CASE WHEN origin_kind = 'message' THEN origin_id END, title,
      locator, title || ' ' || locator, kind, latest_version, actor_kind, actor_id, updated_at, CAST(${sequence} AS BIGINT)
    FROM artifacts`;
  yield* sql`INSERT INTO find_records (kind, record_id, thread_id, chapter_id, message_id, title, detail, body,
      number, at, indexed_sequence)
    SELECT 'chapter', c.id, c.thread_id, c.id, NULL, c.title, c.summary, COALESCE(c.title, '') || ' ' || COALESCE(c.summary, ''), c.number, c.started_at, CAST(${sequence} AS BIGINT)
    FROM chapters c WHERE c.state <> 'moved' AND (c.title IS NOT NULL OR c.summary IS NOT NULL)`;
});
