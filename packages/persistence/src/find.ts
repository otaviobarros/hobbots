import { FindIndex, FindIndexLog, type FindScope } from "@hobbots/agents";
import {
  FIND_KINDS,
  type FindKind,
  FoundMessage,
  FoundRecord,
  searchTerms,
  searchWords,
  snippetOf,
  type ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { EventJournal } from "./journal.ts";
import { moveProjectorCursor, projectorCursor } from "./projector-cursors.ts";
import { sqlOrDie } from "./sql-errors.ts";

// The find index (migration 0105, ADR 037, #1386): the find projector's rows and cursor, and find's
// reads over them and the messages' index (0011). Hobs that retired are left out, and a private
// camp is found only when it is the scope.

const PROJECTOR = "find-index";

/** The most records and messages one find returns. */
const FIND_RECORDS = 30;
const FIND_MESSAGES = 20;

/** The find projector's cursor and rows. */
export const FindIndexLogLive = Layer.effect(
  FindIndexLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* EventJournal;

    // A thread's rows, written again from its records as they stand now: its old rows go, and so do
    // the rows of records that moved into it, which another thread's rows held until now.
    const indexThread = (threadId: ThreadId, sequence: number) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM find_records WHERE thread_id = ${threadId}
          OR (kind = 'decision' AND record_id IN (SELECT id FROM decisions WHERE thread_id = ${threadId}))
          OR (kind = 'artifact' AND record_id IN (SELECT id FROM artifacts WHERE thread_id = ${threadId}))
          OR (kind = 'chapter' AND record_id IN (SELECT id FROM chapters WHERE thread_id = ${threadId}))`;
        yield* sql`INSERT INTO find_records (kind, record_id, thread_id, chapter_id, message_id, title, body, state,
            actor_kind, actor_id, at, indexed_sequence)
          SELECT 'decision', id, thread_id, chapter_id, source_message_id, text, text, state, actor_kind, actor_id,
            recorded_at, CAST(${sequence} AS BIGINT)
          FROM decisions WHERE thread_id = ${threadId}`;
        yield* sql`INSERT INTO find_records (kind, record_id, thread_id, chapter_id, message_id, title, detail, body,
            artifact_kind, version, actor_kind, actor_id, at, indexed_sequence)
          SELECT 'artifact', id, thread_id, chapter_id, CASE WHEN origin_kind = 'message' THEN origin_id END, title,
            locator, title || ' ' || locator, kind, latest_version, actor_kind, actor_id, updated_at,
            CAST(${sequence} AS BIGINT)
          FROM artifacts WHERE thread_id = ${threadId}`;
        yield* sql`INSERT INTO find_records (kind, record_id, thread_id, chapter_id, title, detail, body, number, at,
            indexed_sequence)
          SELECT 'chapter', id, thread_id, id, title, summary, COALESCE(title, '') || ' ' || COALESCE(summary, ''),
            number, started_at, CAST(${sequence} AS BIGINT)
          FROM chapters
          WHERE thread_id = ${threadId} AND state <> 'moved' AND (title IS NOT NULL OR summary IS NOT NULL)`;
      });

    return FindIndexLog.of({
      cursor: sqlOrDie(projectorCursor(sql, PROJECTOR)),
      readAfter: (sequence, limit) => journal.readAfter(sequence, limit),
      index: (sequence, threads) =>
        sqlOrDie(
          Effect.gen(function* () {
            for (const threadId of threads) yield* indexThread(threadId, sequence);
            yield* moveProjectorCursor(sql, PROJECTOR, sequence);
          }).pipe(sql.withTransaction),
        ),
    });
  }),
);

/** A query's text and parameters in one dialect. */
interface DialectQuery {
  readonly text: string;
  readonly params: ReadonlyArray<unknown>;
}

/** A find query in both dialects: SQLite's FTS5 tables, PostgreSQL's expression indexes. */
export interface FindQuery {
  readonly sqlite: DialectQuery;
  readonly pg: DialectQuery;
}

type Row = Record<string, unknown>;

/** Runs a find query on a connection; its rows' keys are in camel case. */
export type FindReader = (query: FindQuery) => Effect.Effect<ReadonlyArray<Row>, unknown>;

/** What to match, written for each dialect's index. */
interface Match {
  readonly sqlite: string;
  readonly pg: string;
}

/** Every term as a quoted prefix; terms hold only letters and digits, so nothing needs escaping. */
const allOf = (terms: ReadonlyArray<string>, words: ReadonlyArray<string>): Match => ({
  sqlite: terms.map((term) => `"${term}"*`).join(" "),
  pg: words.map((word) => `${word}:*`).join(" & "),
});
const anyOf = (terms: ReadonlyArray<string>, words: ReadonlyArray<string>): Match => ({
  sqlite: terms.map((term) => `"${term}"*`).join(" OR "),
  pg: words.map((word) => `${word}:*`).join(" | "),
});

/**
 * A query from its two texts, written with SQLite's `?N` parameters, which PostgreSQL reads as `$N`:
 * the match is the first parameter, then `rest`.
 */
const dialects = (sqlite: string, pg: string, match: Match, rest: ReadonlyArray<unknown>): FindQuery => ({
  sqlite: { text: sqlite, params: [match.sqlite, ...rest] },
  pg: { text: pg.replace(/\?(\d+)/g, "$$$1"), params: [match.pg, ...rest] },
});

/** Who may be found: hobs that did not retire, in one thread (`?2`), or in every thread but private camps. */
const scopeClause = (scope: FindScope) =>
  `a.status <> 'retired' AND ${scope.in === null ? "t.private = 0" : "t.id = ?2"}`;

const scopeParams = (scope: FindScope): ReadonlyArray<unknown> => (scope.in === null ? [] : [scope.in]);

/** The record kinds asked for, as a list SQL reads; the kinds are fixed literals, never input. */
const kindList = (kinds: ReadonlyArray<FindKind>) =>
  FIND_KINDS.filter((kind) => kind !== "message" && kinds.includes(kind))
    .map((kind) => `'${kind}'`)
    .join(", ");

// A chapter's citation opens its first message, read now since a chapter gets messages after its row.
const RECORD_COLUMNS = `r.kind, r.record_id, r.thread_id, r.title, r.detail, r.body, r.state, r.artifact_kind,
  r.version, r.number, r.actor_kind, r.actor_id, r.at,
  COALESCE(r.message_id, CASE WHEN r.kind = 'chapter' THEN
    (SELECT m.id FROM messages m WHERE m.chapter_id = r.chapter_id ORDER BY m.seq LIMIT 1) END) AS message_id,
  t.title AS thread_title, t.kind AS thread_kind, t.agent_id AS hob_id`;

const RECORDS_FROM = "JOIN threads t ON t.id = r.thread_id JOIN agents a ON a.id = t.agent_id";

/** The records that match, in `scope`, in the order given for each dialect. */
const recordsQuery = (
  match: Match,
  scope: FindScope,
  input: { readonly where: string; readonly order: Match; readonly limit: number },
): FindQuery =>
  dialects(
    `SELECT ${RECORD_COLUMNS} FROM find_search s JOIN find_records r ON r.seq = s.rowid ${RECORDS_FROM}
      WHERE find_search MATCH ?1 AND ${scopeClause(scope)}${input.where} ORDER BY ${input.order.sqlite}
      LIMIT ${input.limit}`,
    `SELECT ${RECORD_COLUMNS} FROM find_records r ${RECORDS_FROM}
      WHERE to_tsvector('simple', r.body) @@ to_tsquery('simple', ?1) AND ${scopeClause(scope)}${input.where}
      ORDER BY ${input.order.pg} LIMIT ${input.limit}`,
    match,
    scopeParams(scope),
  );

/** Messages the index leaves out: still queued, or a reply still streaming or stopping. */
const UNSETTLED = "NOT IN ('queued', 'streaming', 'stopping')";

const MESSAGE_COLUMNS = `m.id AS message_id, m.thread_id, m.role, m.content, m.created_at AS at, m.actor_kind,
  m.actor_id, t.title AS thread_title, t.kind AS thread_kind, t.agent_id AS hob_id`;

/** The newest settled messages that match, in `scope`. */
const messagesQuery = (match: Match, scope: FindScope): FindQuery => {
  const from = "JOIN threads t ON t.id = m.thread_id JOIN agents a ON a.id = t.agent_id";
  const rest = `AND m.status ${UNSETTLED} AND ${scopeClause(scope)}
    ORDER BY m.created_at DESC, m.seq DESC LIMIT ${FIND_MESSAGES}`;
  return dialects(
    `SELECT ${MESSAGE_COLUMNS} FROM messages_search s JOIN messages m ON m.rowid = s.rowid ${from}
      WHERE messages_search MATCH ?1 ${rest}`,
    `SELECT ${MESSAGE_COLUMNS} FROM messages m ${from}
      WHERE to_tsvector('simple', m.content) @@ to_tsquery('simple', ?1) ${rest}`,
    match,
    scopeParams(scope),
  );
};

const decodeRecord = Schema.decodeUnknownSync(FoundRecord);
const decodeMessage = Schema.decodeUnknownSync(FoundMessage);

const actorOf = (row: Row) => ({ kind: row.actorKind, id: row.actorId });

/** Where a found row is, and its words that matched. */
const placeOf = (row: Row, text: string, terms: ReadonlyArray<string>) => ({
  threadId: row.threadId,
  threadTitle: row.threadTitle,
  threadKind: row.threadKind,
  hobId: row.hobId,
  messageId: row.messageId ?? null,
  snippet: snippetOf(text, terms),
  at: String(row.at),
});

/** A record row as what find shows. */
const recordOf = (row: Row, terms: ReadonlyArray<string>): FoundRecord => {
  const place = placeOf(row, String(row.body), terms);
  switch (row.kind) {
    case "decision":
      return decodeRecord({
        _tag: "decision",
        ...place,
        id: row.recordId,
        text: row.title,
        state: row.state,
        actor: actorOf(row),
      });
    case "artifact":
      return decodeRecord({
        _tag: "artifact",
        ...place,
        id: row.recordId,
        title: row.title,
        kind: row.artifactKind,
        version: Number(row.version),
        actor: actorOf(row),
      });
    default:
      return decodeRecord({
        _tag: "chapter",
        ...place,
        id: row.recordId,
        number: Number(row.number),
        title: row.title ?? null,
        summary: row.detail ?? null,
      });
  }
};

const messageOf = (row: Row, terms: ReadonlyArray<string>): FoundMessage =>
  decodeMessage({
    _tag: "message",
    ...placeOf(row, String(row.content), terms),
    role: row.role,
    actor: actorOf(row),
  });

/** Ask leaves out words shorter than this, such as "we" or "is", which match too much as a start. */
const ASK_WORD_MIN = 3;

/** Find's reads, on `read`'s connection. */
export const makeFind = (read: FindReader) =>
  FindIndex.of({
    find: (query, scope) => {
      const terms = searchTerms(query);
      if (terms.length === 0) return Effect.succeed({ records: [], messages: [] });
      const match = allOf(terms, searchWords(query));
      const kinds = kindList(scope.kinds);
      const records =
        kinds === ""
          ? Effect.succeed([])
          : read(
              recordsQuery(match, scope, {
                where: ` AND r.kind IN (${kinds})`,
                order: { sqlite: "r.at DESC, r.seq DESC", pg: "r.at DESC, r.seq DESC" },
                limit: FIND_RECORDS,
              }),
            );
      const messages = scope.kinds.includes("message") ? read(messagesQuery(match, scope)) : Effect.succeed([]);
      return Effect.all([records, messages]).pipe(
        Effect.map(([recordRows, messageRows]) => ({
          records: recordRows.map((row) => recordOf(row, terms)),
          messages: messageRows.map((row) => messageOf(row, terms)),
        })),
        Effect.orDie,
      );
    },
    matching: (question, scope, limit) => {
      const terms = searchTerms(question).filter((term) => term.length >= ASK_WORD_MIN);
      const words = searchWords(question).filter((word) => word.length >= ASK_WORD_MIN);
      if (terms.length === 0) return Effect.succeed([]);
      return read(
        recordsQuery(anyOf(terms, words), scope, {
          where: "",
          order: {
            sqlite: "bm25(find_search), r.at DESC",
            pg: "ts_rank(to_tsvector('simple', r.body), to_tsquery('simple', $1)) DESC, r.at DESC",
          },
          limit,
        }),
      ).pipe(
        Effect.map((rows) => rows.map((row) => recordOf(row, terms))),
        Effect.orDie,
      );
    },
  });
