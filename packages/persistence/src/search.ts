import { Worker } from "node:worker_threads";
import {
  type MessageMatch,
  MessageRole,
  type SearchHit,
  searchTerms,
  searchWords,
  snippetOf,
  Thread,
} from "@hobbots/domain";
import { Context, Effect, Layer, Schema, String as Str } from "effect";
import { SqlClient } from "effect/sql";

// Search over thread titles and settled messages (CH-006), on SQLite FTS5 or PostgreSQL full-text
// search (migration 0011). Hobs that retired are left out. On a SQLite file the query runs in a
// worker thread with its own read-only connection, so a long search never blocks the server (ADR 011).

/** The most threads one search returns, and the newest matching messages shown for each. */
export const SEARCH_THREADS = 30;
export const MATCHES_PER_THREAD = 3;

export class SearchIndex extends Context.Service<
  SearchIndex,
  {
    /** Threads whose title or messages contain every word of the query, most recently active first. */
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<SearchHit>>;
  }
>()("@hobbots/persistence/SearchIndex") {
  /** Runs the query on the server's own connection: PostgreSQL, or SQLite in tests. */
  static readonly layer = Layer.effect(
    SearchIndex,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const run: Run = (terms, words) =>
        sql.onDialectOrElse({
          pg: () => sql.unsafe(PG_QUERY, [tsQuery(words)]),
          orElse: () => sql.unsafe(SQLITE_QUERY, [ftsQuery(terms)]),
        }) as Effect.Effect<ReadonlyArray<Row>, unknown>;
      return makeSearch(run);
    }),
  );

  /**
   * Runs the query in a worker thread on the SQLite database at `filename`, which the server's
   * connection must already have migrated. The worker starts with the first search.
   */
  static readonly sqliteWorker = (filename: string) =>
    Layer.effect(
      SearchIndex,
      Effect.gen(function* () {
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new WorkerConnection(filename)),
          (connection) => Effect.promise(() => connection.close()),
        );
        return makeSearch((terms) =>
          pool.all(SQLITE_QUERY, [ftsQuery(terms)]).pipe(Effect.map((rows) => rows.map(camelCaseRow))),
        );
      }),
    );
}

type Row = Record<string, unknown>;
type Run = (terms: ReadonlyArray<string>, words: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Row>, unknown>;

/**
 * After `titled` (threads whose title matches) and `matched` (finished messages that match), both
 * dialects pick the threads first and only then their newest matches, so a thread with many
 * matches never crowds another out and every count is complete.
 */
const THREADS_THEN_MATCHES = `
  counts AS (SELECT thread_id, CAST(COUNT(*) AS INTEGER) AS match_count FROM matched GROUP BY thread_id),
  found AS (
    SELECT t.*, t.id IN (SELECT id FROM titled) AS title_match, COALESCE(c.match_count, 0) AS match_count
    FROM threads t JOIN agents a ON a.id = t.agent_id LEFT JOIN counts c ON c.thread_id = t.id
    WHERE a.status <> 'retired' AND (c.thread_id IS NOT NULL OR t.id IN (SELECT id FROM titled))
    ORDER BY t.updated_at DESC LIMIT ${SEARCH_THREADS}),
  ranked AS (
    SELECT matched.*, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC, seq DESC) AS match_rank
    FROM matched WHERE thread_id IN (SELECT id FROM found))
SELECT f.*, r.id AS message_id, r.role AS message_role, r.content AS message_content,
  r.created_at AS message_created_at
FROM found f LEFT JOIN ranked r ON r.thread_id = f.id AND r.match_rank <= ${MATCHES_PER_THREAD}
ORDER BY f.updated_at DESC, f.id, r.match_rank`;

/** Messages the index leaves out: still queued, or a reply still streaming or stopping. */
const UNSETTLED = "NOT IN ('queued', 'streaming', 'stopping')";
const MATCHED_COLUMNS = "m.thread_id, m.id, m.role, m.content, m.created_at, m.seq";

/** SQLite's query, shared by the in-process and worker connections. */
const SQLITE_QUERY = `WITH
  titled AS (SELECT t.id FROM threads_search s JOIN threads t ON t.rowid = s.rowid WHERE threads_search MATCH ?1),
  matched AS (
    SELECT ${MATCHED_COLUMNS} FROM messages_search s JOIN messages m ON m.rowid = s.rowid
    WHERE messages_search MATCH ?1 AND m.status ${UNSETTLED}),${THREADS_THEN_MATCHES}`;

/** PostgreSQL's query, on its language-neutral configuration, which keeps accents. */
const PG_QUERY = `WITH
  titled AS (SELECT id FROM threads WHERE to_tsvector('simple', title) @@ to_tsquery('simple', $1)),
  matched AS (
    SELECT ${MATCHED_COLUMNS} FROM messages m
    WHERE to_tsvector('simple', m.content) @@ to_tsquery('simple', $1) AND m.status ${UNSETTLED}),${THREADS_THEN_MATCHES}`;

/** Every term as a quoted prefix; terms hold only letters and digits, so nothing needs escaping. */
const ftsQuery = (terms: ReadonlyArray<string>) => terms.map((term) => `"${term}"*`).join(" ");
const tsQuery = (words: ReadonlyArray<string>) => words.map((word) => `${word}:*`).join(" & ");

const camelCaseRow = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [Str.snakeToCamel(key), value]));

const decodeThread = Schema.decodeUnknownSync(Thread);
const decodeRole = Schema.decodeUnknownSync(MessageRole);

const makeSearch = (run: Run) =>
  SearchIndex.of({
    search: (query) => {
      const terms = searchTerms(query);
      if (terms.length === 0) return Effect.succeed([]);
      return run(terms, searchWords(query)).pipe(
        Effect.map((rows) => groupHits(rows, terms)),
        Effect.orDie,
      );
    },
  });

/** One hit per thread, in the query's order, with its newest matching messages. */
const groupHits = (rows: ReadonlyArray<Row>, terms: ReadonlyArray<string>): Array<SearchHit> => {
  const hits = new Map<string, { thread: Thread; titleMatch: boolean; matchCount: number; matches: MessageMatch[] }>();
  for (const row of rows) {
    // PostgreSQL reads BIGINT as a bigint and SQLite as a number; every revision fits a number.
    const thread = decodeThread({ ...row, revision: Number(row.revision) });
    let hit = hits.get(thread.id);
    if (!hit) {
      // SQLite answers 0 or 1 where PostgreSQL answers a boolean.
      hit = { thread, titleMatch: Boolean(row.titleMatch), matchCount: Number(row.matchCount), matches: [] };
      hits.set(thread.id, hit);
    }
    if (row.messageId != null)
      hit.matches.push({
        messageId: row.messageId as MessageMatch["messageId"],
        role: decodeRole(row.messageRole),
        createdAt: String(row.messageCreatedAt),
        snippet: snippetOf(String(row.messageContent), terms),
      });
  }
  return [...hits.values()];
};

// The worker is plain JavaScript evaluated from this string, so it needs no separate file to find
// under tsx, Vitest or the bundled desktop app. It only reads.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const statements = new Map();
parentPort.on("message", ({ id, sql, params }) => {
  try {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    parentPort.postMessage({ id, rows: statement.all(...params) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
});
`;

type Reply = { readonly id: number; readonly rows?: ReadonlyArray<Row>; readonly error?: string };

/** One read-only SQLite connection in a worker thread, started on first use and again after a crash. */
class WorkerConnection {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, (reply: Reply) => void>();

  constructor(private readonly filename: string) {}

  all(sql: string, params: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<Row>, Error> {
    return Effect.callback<ReadonlyArray<Row>, Error>((resume) => {
      const id = this.nextId++;
      this.pending.set(id, (reply) =>
        resume(reply.rows ? Effect.succeed(reply.rows) : Effect.fail(new Error(reply.error ?? "Search failed"))),
      );
      this.start().postMessage({ id, sql, params });
      return Effect.sync(() => this.pending.delete(id));
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { filename: this.filename } });
    // An idle worker does not keep the process alive.
    worker.unref();
    worker.on("message", (reply: Reply) => {
      const done = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      done?.(reply);
    });
    const fail = (error: unknown) => {
      if (this.worker === worker) this.worker = undefined;
      const message = error instanceof Error ? error.message : `Search worker stopped (${String(error)})`;
      for (const [id, done] of this.pending) done({ id, error: message });
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", fail);
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}
