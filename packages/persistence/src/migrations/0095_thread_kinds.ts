import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A thread is a chat or a camp, with a goal, a private flag, the thread and chapter it came from, and
// a lifecycle state (ADR 037, #1375). `archived_at` stays as a fact beside the state.
//
// Each hob's most recent open thread becomes its chat, by the order its chats are listed in (last
// activity first, ties by id), leaving out skill trials, which stay camps. Every other thread becomes
// a camp and keeps its title. A partial unique index then lets a hob have only one open chat, so the
// database refuses a second, not only the service.
//
// Each journaled `ThreadUpserted` gets the same fields, its payload version becoming 4: the kind the
// thread has now, and the state its own `archivedAt` says (open when it has none), so an old entry
// decodes as it was.

const PAGE = 500;

type Stored = Record<string, unknown>;

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'camp'`;
  yield* sql`ALTER TABLE threads ADD COLUMN goal TEXT`;
  yield* sql`ALTER TABLE threads ADD COLUMN private INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE threads ADD COLUMN origin_thread_id TEXT`;
  yield* sql`ALTER TABLE threads ADD COLUMN origin_chapter_id TEXT`;
  yield* sql`ALTER TABLE threads ADD COLUMN state TEXT NOT NULL DEFAULT 'open'`;
  yield* sql`UPDATE threads SET state = 'archived' WHERE archived_at IS NOT NULL`;

  // Ids compare byte by byte, as the repository sorts them: SQLite's default, PostgreSQL's "C" collation.
  const byId = sql.onDialectOrElse({ pg: () => sql.literal(`id COLLATE "C"`), orElse: () => sql.literal("id") });
  yield* sql`UPDATE threads SET kind = 'chat' WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY updated_at DESC, ${byId}) AS place
      FROM threads WHERE state = 'open' AND skill_trial IS NULL
    ) ranked WHERE place = 1
  )`;
  yield* sql`CREATE UNIQUE INDEX threads_one_open_chat ON threads (agent_id) WHERE kind = 'chat' AND state = 'open'`;

  const chats = new Set(
    (yield* sql<{ id: string }>`SELECT id FROM threads WHERE kind = 'chat'`).map((row) => String(row.id)),
  );
  let after = 0;
  for (;;) {
    const events = yield* sql<{ sequence: unknown; payload: string }>`SELECT sequence, payload FROM event_journal
      WHERE type = 'ThreadUpserted' AND schema_version < 4 AND sequence > ${after} ORDER BY sequence LIMIT ${PAGE}`;
    for (const event of events) {
      const payload = JSON.parse(event.payload) as { thread: Stored } & Stored;
      const thread = payload.thread;
      const next = {
        ...payload,
        thread: {
          ...thread,
          kind: chats.has(String(thread.id)) ? "chat" : "camp",
          goal: null,
          private: false,
          origin: null,
          state: thread.archivedAt == null ? "open" : "archived",
        },
      };
      yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(next)}, schema_version = 4
        WHERE sequence = ${event.sequence}`;
    }
    if (events.length < PAGE) break;
    after = Number(events[events.length - 1]?.sequence);
  }
});
