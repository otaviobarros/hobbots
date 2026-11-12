import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Decisions and the artifacts registry (ADR 037, Records, #1383), and an explicit author on every
// message (ADR 037, Every author is an actor).
//
// A decision is kept for good: crossing it out sets its state and who replaced it, never its text.
// Each is recorded under a request key, so a retried call or request records it once, and keeps the
// journal sequence it was recorded at, which orders a thread's decisions.
//
// An artifact is one row per thing a hob made or changed in a chat or camp, unique by where it is
// (`locator`) in its thread. `artifact_sightings` holds each record that saw it, so a replayed or
// repeated record never counts as a new version.
//
// Every message names its author: you for your messages, the thread's hob for its replies. As with
// 0099's chapter, PostgreSQL sets NOT NULL and SQLite refuses a message without one by trigger.
// Journaled `MessageUpserted` (version 6) and `MessageQueued` (version 3) entries get the same
// author, the hob taken from the entry's own hob column, so every old entry decodes with one.

const PAGE = 500;

type Stored = Record<string, unknown>;

/** The author of a stored message: you, or the hob of its thread. */
const authorOf = (message: Stored, agentId: unknown): Stored =>
  message.role === "user" ? { kind: "user", id: "owner" } : { kind: "hob", id: String(agentId) };

const REWRITES: ReadonlyArray<{ readonly type: string; readonly version: number }> = [
  { type: "MessageUpserted", version: 6 },
  { type: "MessageQueued", version: 3 },
];

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    source_message_id TEXT,
    text TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'superseded')),
    superseded_by TEXT REFERENCES decisions(id),
    recorded_at TEXT NOT NULL,
    superseded_at TEXT,
    request_key TEXT NOT NULL UNIQUE,
    request_input TEXT NOT NULL,
    recorded_sequence BIGINT NOT NULL,
    revision BIGINT NOT NULL
  )`;
  yield* sql`CREATE INDEX decisions_thread ON decisions (thread_id, recorded_sequence)`;
  yield* sql`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    locator TEXT NOT NULL,
    latest_version INTEGER NOT NULL,
    origin_kind TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision BIGINT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX artifacts_locator ON artifacts (thread_id, locator)`;
  yield* sql`CREATE INDEX artifacts_thread ON artifacts (thread_id, updated_at)`;
  yield* sql`CREATE TABLE artifact_sightings (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    origin_kind TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    PRIMARY KEY (artifact_id, origin_kind, origin_id)
  )`;

  yield* sql`ALTER TABLE messages ADD COLUMN actor_kind TEXT`;
  yield* sql`ALTER TABLE messages ADD COLUMN actor_id TEXT`;
  yield* sql`UPDATE messages SET actor_kind = 'user', actor_id = 'owner' WHERE role = 'user'`;
  yield* sql`UPDATE messages SET actor_kind = 'hob',
    actor_id = (SELECT t.agent_id FROM threads t WHERE t.id = messages.thread_id) WHERE role <> 'user'`;
  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        yield* sql`ALTER TABLE messages ALTER COLUMN actor_kind SET NOT NULL`;
        yield* sql`ALTER TABLE messages ALTER COLUMN actor_id SET NOT NULL`;
      }),
    orElse: () =>
      Effect.gen(function* () {
        const abort = sql.literal(`BEGIN SELECT RAISE(ABORT, 'messages.actor_kind and actor_id are required'); END`);
        yield* sql`CREATE TRIGGER messages_actor_required_insert BEFORE INSERT ON messages
          WHEN NEW.actor_kind IS NULL OR NEW.actor_id IS NULL ${abort}`;
        yield* sql`CREATE TRIGGER messages_actor_required_update BEFORE UPDATE OF actor_kind, actor_id ON messages
          WHEN NEW.actor_kind IS NULL OR NEW.actor_id IS NULL ${abort}`;
      }),
  });

  for (const rewrite of REWRITES) {
    let sequence = 0;
    for (;;) {
      const events = yield* sql<{
        sequence: unknown;
        agent_id: unknown;
        payload: string;
      }>`SELECT sequence, agent_id, payload FROM event_journal
        WHERE type = ${rewrite.type} AND schema_version < ${rewrite.version} AND sequence > ${sequence}
        ORDER BY sequence LIMIT ${PAGE}`;
      for (const event of events) {
        const payload = JSON.parse(event.payload) as Stored;
        const message = payload.message as Stored;
        const changed = { ...payload, message: { ...message, actor: authorOf(message, event.agent_id) } };
        yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(changed)}, schema_version = ${rewrite.version}
          WHERE sequence = ${event.sequence}`;
      }
      if (events.length < PAGE) break;
      sequence = Number(events[events.length - 1]?.sequence);
    }
  }
});
