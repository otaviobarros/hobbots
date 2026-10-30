import { Worker } from "node:worker_threads";
import { type MessageMatch, MessageRole, type SearchHit, searchTerms, snippetOf, Thread } from "@hobbots/domain";
import { Context, Effect, Layer, Schema, String as Str } from "effect";
import { SqlClient } from "effect/sql";

// Search over thread titles and finished messages (CH-006), on SQLite FTS5 or PostgreSQL full-text
// search (migration 0011). Hobs that retired are left out. On a SQLite file the queries run in a
// worker thread with its own read-only connection, so a long search never blocks the server (ADR 011).

/** The most threads one search returns, and the newest matching messages shown for each. */
export const SEARCH_THREADS = 30;
export const MATCHES_PER_THREAD = 3;
const MESSAGE_ROWS = 300;

export class SearchIndex extends Context.Service<
  SearchIndex,
  {
    /** Threads whose title or messages contain every word of the query, most recently active first. */
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<SearchHit>>;
  }
>()("@hobbots/persistence/SearchIndex") {
  /** Runs the queries on the server's own connection: PostgreSQL, or SQLite in tests. */
  static readonly layer = Layer.effect(
    SearchIndex,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const run: Run = (query, terms) =>
        sql.onDialectOrElse({
          pg: () => {
            // Prefix queries on PostgreSQL's language-neutral configuration; it keeps accents.
            const tsquery = terms.map((term) => `${term}:*`).join(" & ");
            return query === "titles"
              ? sql`SELECT t.* FROM threads t JOIN agents a ON a.id = t.agent_id
                  WHERE to_tsvector('simple', t.title) @@ to_tsquery('simple', ${tsquery})
                    AND a.status <> 'retired'
                  ORDER BY t.updated_at DESC LIMIT ${SEARCH_THREADS}`
              : sql`SELECT ${sql.literal(MESSAGE_SELECT)} FROM messages m
                  JOIN threads t ON t.id = m.thread_id JOIN agents a ON a.id = t.agent_id
                  WHERE to_tsvector('simple', m.content) @@ to_tsquery('simple', ${tsquery})
                    AND m.status <> 'streaming' AND a.status <> 'retired'
                  ORDER BY m.created_at DESC, m.seq DESC LIMIT ${MESSAGE_ROWS}`;
          },
          orElse: () => sql.unsafe(sqliteQueries[query], [ftsQuery(terms)]),
        }) as Effect.Effect<ReadonlyArray<Row>, unknown>;
      return makeSearch(run);
    }),
  );

  /**
   * Runs the queries in a worker thread on the SQLite database at `filename`, which the server's
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
        return makeSearch((query, terms) =>
          pool.all(sqliteQueries[query], [ftsQuery(terms)]).pipe(Effect.map((rows) => rows.map(camelCaseRow))),
        );
      }),
    );
}

type Row = Record<string, unknown>;
type Run = (
  query: keyof typeof sqliteQueries,
  terms: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<Row>, unknown>;

// The message query names its columns, so a thread's and a message's `id` do not collide.
const MESSAGE_SELECT = `m.id AS message_id, m.role AS message_role, m.content AS message_content,
  m.created_at AS message_created_at, t.id, t.agent_id, t.title, t.runtime_session_id, t.created_at, t.updated_at`;

/** SQLite's queries, shared by the in-process and worker connections. */
const sqliteQueries = {
  titles: `SELECT t.* FROM threads_search s
    JOIN threads t ON t.rowid = s.rowid JOIN agents a ON a.id = t.agent_id
    WHERE threads_search MATCH ? AND a.status <> 'retired'
    ORDER BY t.updated_at DESC LIMIT ${SEARCH_THREADS}`,
  messages: `SELECT ${MESSAGE_SELECT} FROM messages_search s
    JOIN messages m ON m.rowid = s.rowid
    JOIN threads t ON t.id = m.thread_id JOIN agents a ON a.id = t.agent_id
    WHERE messages_search MATCH ? AND m.status <> 'streaming' AND a.status <> 'retired'
    ORDER BY m.created_at DESC, m.seq DESC LIMIT ${MESSAGE_ROWS}`,
} as const;

/** Every term as a quoted prefix; terms hold only letters and digits, so nothing needs escaping. */
const ftsQuery = (terms: ReadonlyArray<string>) => terms.map((term) => `"${term}"*`).join(" ");

const camelCaseRow = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [Str.snakeToCamel(key), value]));

const decodeThread = Schema.decodeUnknownSync(Thread);
const decodeRole = Schema.decodeUnknownSync(MessageRole);

const makeSearch = (run: Run) =>
  SearchIndex.of({
    search: (query) => {
      const terms = searchTerms(query);
      if (terms.length === 0) return Effect.succeed([]);
      return Effect.all([run("titles", terms), run("messages", terms)], { concurrency: 2 }).pipe(
        Effect.map(([titles, messages]) => groupHits(titles, messages, terms)),
        Effect.orDie,
      );
    },
  });

/** One hit per thread, most recently active first, with its newest matching messages. */
const groupHits = (
  titleRows: ReadonlyArray<Row>,
  messageRows: ReadonlyArray<Row>,
  terms: ReadonlyArray<string>,
): Array<SearchHit> => {
  const hits = new Map<string, { thread: Thread; titleMatch: boolean; matchCount: number; matches: MessageMatch[] }>();
  const hitFor = (row: Row) => {
    const thread = decodeThread(row);
    const existing = hits.get(thread.id);
    if (existing) return existing;
    const hit = { thread, titleMatch: false, matchCount: 0, matches: [] as MessageMatch[] };
    hits.set(thread.id, hit);
    return hit;
  };
  for (const row of titleRows) hitFor(row).titleMatch = true;
  for (const row of messageRows) {
    const hit = hitFor(row);
    hit.matchCount += 1;
    if (hit.matches.length < MATCHES_PER_THREAD)
      hit.matches.push({
        messageId: row.messageId as MessageMatch["messageId"],
        role: decodeRole(row.messageRole),
        createdAt: String(row.messageCreatedAt),
        snippet: snippetOf(String(row.messageContent), terms),
      });
  }
  return [...hits.values()]
    .sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt))
    .slice(0, SEARCH_THREADS);
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
