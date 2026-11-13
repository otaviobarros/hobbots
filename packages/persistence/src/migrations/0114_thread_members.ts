import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Who is in each direct message and camp (ADR 039, Members; #1453). A member is a person or a hob,
// one row per thread and actor. Every thread gets two members here, in one pass: the owner, with role
// `owner`, who made every thread so far, and its hob, both added by the owner when the thread was
// made. A retired hob has left its threads, and comes back to them when it returns. The thread's read
// marker becomes the owner's `read_revision`; a hob reads nothing, so its marker stays null.
//
// `role` and `state` take only the values below, written out as they stand now: PostgreSQL refuses
// any other with named CHECK constraints, SQLite with triggers, so a later state can widen them.
export const MEMBER_ROLES = ["owner", "member"] as const;
export const MEMBER_STATES = ["active", "left", "removed"] as const;

const quoted = (values: ReadonlyArray<string>) => values.map((value) => `'${value}'`).join(", ");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_members (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    added_by_kind TEXT NOT NULL,
    added_by_id TEXT NOT NULL,
    read_revision BIGINT,
    muted_until TEXT,
    revision BIGINT NOT NULL,
    PRIMARY KEY (thread_id, actor_kind, actor_id)
  )`;
  // A hob's retirement and return find its rows in every thread.
  yield* sql`CREATE INDEX thread_members_actor ON thread_members (actor_kind, actor_id)`;
  for (const [column, values] of [
    ["role", MEMBER_ROLES],
    ["state", MEMBER_STATES],
  ] as const) {
    const list = quoted(values);
    yield* sql.onDialectOrElse({
      pg: () =>
        sql.unsafe(`ALTER TABLE thread_members ADD CONSTRAINT thread_members_${column}_known
          CHECK (${column} IN (${list}))`),
      orElse: () =>
        Effect.gen(function* () {
          const abort = `BEGIN SELECT RAISE(ABORT, 'thread_members.${column} must be one of ${values.join(", ")}'); END`;
          yield* sql.unsafe(`CREATE TRIGGER thread_members_${column}_known_insert BEFORE INSERT ON thread_members
            WHEN NEW.${column} NOT IN (${list}) ${abort}`);
          yield* sql.unsafe(`CREATE TRIGGER thread_members_${column}_known_update BEFORE UPDATE OF ${column}
            ON thread_members WHEN NEW.${column} NOT IN (${list}) ${abort}`);
        }),
    });
  }

  yield* sql`INSERT INTO thread_members (thread_id, actor_kind, actor_id, role, state, joined_at,
      added_by_kind, added_by_id, read_revision, muted_until, revision)
    SELECT id, 'user', 'owner', 'owner', 'active', created_at, 'user', 'owner', read_revision, NULL, revision
    FROM threads`;
  yield* sql`INSERT INTO thread_members (thread_id, actor_kind, actor_id, role, state, joined_at,
      added_by_kind, added_by_id, read_revision, muted_until, revision)
    SELECT t.id, 'hob', t.agent_id, 'member',
      CASE WHEN a.status = 'retired' THEN 'left' ELSE 'active' END,
      t.created_at, 'user', 'owner', NULL, NULL, t.revision
    FROM threads t JOIN agents a ON a.id = t.agent_id`;
});
