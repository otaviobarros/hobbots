import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each answer a hob owes a conversation (ADR 039, One hob speaks at a time; #1461), written with the
// message that caused it. The floor takes the oldest waiting request first, ordered by `queued_at`
// (the causing message's journal revision) then `position` (its place among that message's
// requests). `root_message_id` is null for a thread's main line. A request is not journaled: clients
// see the floor through the thread's run.
//
// Messages still queued when this runs each owed their thread's hob an answer, so each gets a
// waiting request, caused by its author, for its thread's only hob.
//
// `state` and `cause` take only the values below, written out as they stand now: PostgreSQL refuses
// any other with named CHECK constraints, SQLite with triggers, so a later value can widen them.
export const TURN_REQUEST_STATES = ["waiting", "paused", "speaking", "answered", "passed", "dropped"] as const;
export const TURN_CAUSES = ["mention", "reply", "relay", "only-hob", "lead"] as const;

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `'${value}'`).join(", ");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE turn_requests (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    root_message_id TEXT,
    hob_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    caused_by_kind TEXT NOT NULL,
    caused_by_id TEXT NOT NULL,
    cause TEXT NOT NULL,
    relay_depth INTEGER NOT NULL,
    state TEXT NOT NULL,
    reply_id TEXT,
    dropped_by_kind TEXT,
    dropped_by_id TEXT,
    queued_at BIGINT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`;
  // The floor reads a line's open requests; a start finds every open one.
  yield* sql`CREATE INDEX turn_requests_line ON turn_requests (thread_id, root_message_id, state)`;
  yield* sql`CREATE INDEX turn_requests_state ON turn_requests (state)`;
  yield* sql`CREATE INDEX turn_requests_message ON turn_requests (message_id)`;
  yield* sql`CREATE INDEX turn_requests_reply ON turn_requests (reply_id)`;
  for (const [column, values] of [
    ["state", TURN_REQUEST_STATES],
    ["cause", TURN_CAUSES],
  ] as const) {
    const list = quoted(values);
    yield* sql.onDialectOrElse({
      pg: () =>
        sql.unsafe(`ALTER TABLE turn_requests ADD CONSTRAINT turn_requests_${column}_known
          CHECK (${column} IN (${list}))`),
      orElse: () =>
        Effect.gen(function* () {
          const abort = `BEGIN SELECT RAISE(ABORT, 'turn_requests.${column} must be one of ${values.join(", ")}'); END`;
          yield* sql.unsafe(`CREATE TRIGGER turn_requests_${column}_known_insert BEFORE INSERT ON turn_requests
            WHEN NEW.${column} NOT IN (${list}) ${abort}`);
          yield* sql.unsafe(`CREATE TRIGGER turn_requests_${column}_known_update BEFORE UPDATE OF ${column}
            ON turn_requests WHEN NEW.${column} NOT IN (${list}) ${abort}`);
        }),
    });
  }

  // The message's id names its request too. Its revision orders it, as a new request's does.
  yield* sql`INSERT INTO turn_requests (id, thread_id, root_message_id, hob_id, message_id, caused_by_kind,
      caused_by_id, cause, relay_depth, state, reply_id, dropped_by_kind, dropped_by_id, queued_at, position,
      created_at)
    SELECT m.id, m.thread_id, NULL, t.agent_id, m.id, m.actor_kind, m.actor_id, 'only-hob', 0, 'waiting',
      NULL, NULL, NULL, m.revision, 0, m.created_at
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.status = 'queued'`;
});
