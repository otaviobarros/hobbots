import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Full-text search over thread titles and messages (CH-006). Each dialect keeps its index current
// in the same statement as the write: SQLite through FTS5 tables kept by triggers, PostgreSQL
// through GIN expression indexes. Both split text into words and match words or their beginnings.
// A message is indexed once it settles: a queued message may still be removed, and a reply is not
// indexed again for each piece while it streams or stops.
// Fixed here rather than taken from the domain, so this migration never changes after it runs.
const UNSETTLED = "NOT IN ('queued', 'streaming', 'stopping')";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql`CREATE INDEX threads_title_search ON threads USING GIN (to_tsvector('simple', title))`;
        // Like SQLite's, the message index leaves out messages that have not settled.
        yield* sql.unsafe(`CREATE INDEX messages_content_search ON messages USING GIN (to_tsvector('simple', content))
          WHERE status ${UNSETTLED}`);
      }),
    orElse: () =>
      Effect.gen(function* () {
        // External-content tables store only the index; the rows stay in threads and messages.
        yield* sql`CREATE VIRTUAL TABLE threads_search USING fts5(
          title, content = 'threads', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
        )`;
        yield* sql`INSERT INTO threads_search (threads_search) VALUES ('rebuild')`;
        yield* sql`CREATE TRIGGER threads_search_insert AFTER INSERT ON threads BEGIN
          INSERT INTO threads_search (rowid, title) VALUES (new.rowid, new.title);
        END`;
        yield* sql`CREATE TRIGGER threads_search_update AFTER UPDATE OF title ON threads BEGIN
          INSERT INTO threads_search (threads_search, rowid, title) VALUES ('delete', old.rowid, old.title);
          INSERT INTO threads_search (rowid, title) VALUES (new.rowid, new.title);
        END`;
        yield* sql`CREATE TRIGGER threads_search_delete AFTER DELETE ON threads BEGIN
          INSERT INTO threads_search (threads_search, rowid, title) VALUES ('delete', old.rowid, old.title);
        END`;

        yield* sql`CREATE VIRTUAL TABLE messages_search USING fts5(
          content, content = 'messages', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
        )`;
        // Only settled messages are in the index, so the triggers add and remove exactly those.
        yield* sql.unsafe(`INSERT INTO messages_search (rowid, content)
          SELECT rowid, content FROM messages WHERE status ${UNSETTLED}`);
        yield* sql.unsafe(`CREATE TRIGGER messages_search_insert AFTER INSERT ON messages
          WHEN new.status ${UNSETTLED} BEGIN
          INSERT INTO messages_search (rowid, content) VALUES (new.rowid, new.content);
        END`);
        // One trigger, so the old words leave the index before the new ones arrive.
        yield* sql.unsafe(`CREATE TRIGGER messages_search_update AFTER UPDATE OF content, status ON messages BEGIN
          INSERT INTO messages_search (messages_search, rowid, content)
            SELECT 'delete', old.rowid, old.content WHERE old.status ${UNSETTLED};
          INSERT INTO messages_search (rowid, content)
            SELECT new.rowid, new.content WHERE new.status ${UNSETTLED};
        END`);
        yield* sql.unsafe(`CREATE TRIGGER messages_search_delete AFTER DELETE ON messages
          WHEN old.status ${UNSETTLED} BEGIN
          INSERT INTO messages_search (messages_search, rowid, content) VALUES ('delete', old.rowid, old.content);
        END`);
      }),
  });
});
