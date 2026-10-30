import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Full-text search over thread titles and messages (CH-006). Each dialect keeps its index current
// in the same statement as the write: SQLite through FTS5 tables kept by triggers, PostgreSQL
// through GIN expression indexes. Both split text into words and match words or their beginnings.
// A reply is indexed once it stops streaming, so a long reply is not indexed again for each piece.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql`CREATE INDEX threads_title_search ON threads USING GIN (to_tsvector('simple', title))`;
        // Like SQLite's, the message index leaves out replies that are still streaming.
        yield* sql`CREATE INDEX messages_content_search ON messages USING GIN (to_tsvector('simple', content))
          WHERE status <> 'streaming'`;
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
        // Only messages that stopped streaming are in the index, so the triggers add and remove exactly those.
        yield* sql`INSERT INTO messages_search (rowid, content)
          SELECT rowid, content FROM messages WHERE status <> 'streaming'`;
        yield* sql`CREATE TRIGGER messages_search_insert AFTER INSERT ON messages
          WHEN new.status <> 'streaming' BEGIN
          INSERT INTO messages_search (rowid, content) VALUES (new.rowid, new.content);
        END`;
        // One trigger, so the old words leave the index before the new ones arrive.
        yield* sql`CREATE TRIGGER messages_search_update AFTER UPDATE OF content, status ON messages BEGIN
          INSERT INTO messages_search (messages_search, rowid, content)
            SELECT 'delete', old.rowid, old.content WHERE old.status <> 'streaming';
          INSERT INTO messages_search (rowid, content)
            SELECT new.rowid, new.content WHERE new.status <> 'streaming';
        END`;
        yield* sql`CREATE TRIGGER messages_search_delete AFTER DELETE ON messages
          WHEN old.status <> 'streaming' BEGIN
          INSERT INTO messages_search (messages_search, rowid, content) VALUES ('delete', old.rowid, old.content);
        END`;
      }),
  });
});
