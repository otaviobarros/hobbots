import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A thread's transcript is split into chapters, one per topic (ADR 037, #1379). Exactly one chapter
// of a thread is live, held by a partial unique index, and every message belongs to one chapter.
//
// Each thread gets one live chapter holding its whole history, started when the thread was made and
// with no title. Every message joins it. `messages.chapter_id` cannot be added as NOT NULL with no
// default on SQLite, so there triggers refuse a message without a chapter, as 0046 does for states;
// PostgreSQL sets NOT NULL.
//
// A runtime session now belongs to a chapter, so each session a thread keeps is given its thread's
// chapter, and goes on being resumed. Merged chapters are remembered by id, so merging one again
// changes nothing.
//
// Journaled entries get the same fields: a `ThreadUpserted` its sessions' chapter and the thread's
// `liveChapterId` (version 5), as do the threads of a `CampMade` and a `ChatStartedFresh` (version 2,
// #1376), and a `MessageUpserted` (version 5) or `MessageQueued` (version 2) its
// message's chapter, so every old entry decodes.

const PAGE = 500;

type Stored = Record<string, unknown>;

/** The rewrites of one journaled event type: the version it reaches and how its payload changes. */
interface Rewrite {
  readonly type: string;
  readonly version: number;
  readonly change: (payload: Stored, chapterOf: (threadId: unknown) => string) => Stored;
}

const withChapters = (thread: Stored, chapterOf: (threadId: unknown) => string): Stored => {
  const chapterId = chapterOf(thread.id);
  const sessions = Array.isArray(thread.sessions) ? (thread.sessions as ReadonlyArray<Stored>) : [];
  return { ...thread, sessions: sessions.map((session) => ({ ...session, chapterId })), liveChapterId: chapterId };
};

const inChapter = (payload: Stored, chapterOf: (threadId: unknown) => string): Stored => {
  const message = payload.message as Stored;
  return { ...payload, message: { ...message, chapterId: chapterOf(message.threadId) } };
};

const REWRITES: ReadonlyArray<Rewrite> = [
  {
    type: "ThreadUpserted",
    version: 5,
    change: (payload, chapterOf) => ({ ...payload, thread: withChapters(payload.thread as Stored, chapterOf) }),
  },
  {
    type: "CampMade",
    version: 2,
    change: (payload, chapterOf) => ({ ...payload, thread: withChapters(payload.thread as Stored, chapterOf) }),
  },
  {
    type: "ChatStartedFresh",
    version: 2,
    change: (payload, chapterOf) => ({
      ...payload,
      superseded: withChapters(payload.superseded as Stored, chapterOf),
      chat: withChapters(payload.chat as Stored, chapterOf),
    }),
  },
  { type: "MessageUpserted", version: 5, change: inChapter },
  { type: "MessageQueued", version: 2, change: inChapter },
];

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  yield* sql`CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    number INTEGER NOT NULL,
    title TEXT,
    summary TEXT,
    state TEXT NOT NULL CHECK (state IN ('live', 'resting', 'moved')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    moved_to TEXT REFERENCES threads(id),
    revision BIGINT NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX chapters_thread ON chapters (thread_id, number)`;
  yield* sql`CREATE UNIQUE INDEX chapters_one_live ON chapters (thread_id) WHERE state = 'live'`;
  yield* sql`CREATE TABLE merged_chapters (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    into_id TEXT NOT NULL,
    merged_at TEXT NOT NULL
  )`;
  yield* sql`ALTER TABLE messages ADD COLUMN chapter_id TEXT REFERENCES chapters(id)`;

  // One chapter per thread, holding its history; its sessions now belong to it.
  const chapters = new Map<string, string>();
  let after = "";
  for (;;) {
    const threads = yield* sql<{
      id: string;
      created_at: string;
      sessions: string | null;
    }>`SELECT id, created_at, sessions
      FROM threads WHERE id > ${after} ORDER BY id LIMIT ${PAGE}`;
    for (const thread of threads) {
      const chapterId = crypto.randomUUID();
      chapters.set(String(thread.id), chapterId);
      yield* sql`INSERT INTO chapters ${sql.insert({
        id: chapterId,
        thread_id: thread.id,
        number: 1,
        title: null,
        summary: null,
        state: "live",
        started_at: thread.created_at,
        ended_at: null,
        moved_to: null,
        revision: 0,
      })}`;
      const sessions = JSON.parse(thread.sessions ?? "[]") as ReadonlyArray<Stored>;
      if (sessions.length > 0) {
        const keyed = JSON.stringify(sessions.map((session) => ({ ...session, chapterId })));
        yield* sql`UPDATE threads SET sessions = ${keyed} WHERE id = ${thread.id}`;
      }
    }
    if (threads.length < PAGE) break;
    after = String(threads[threads.length - 1]?.id);
  }
  yield* sql`UPDATE messages SET chapter_id = (SELECT c.id FROM chapters c WHERE c.thread_id = messages.thread_id)`;

  yield* sql.onDialectOrElse({
    pg: () => sql`ALTER TABLE messages ALTER COLUMN chapter_id SET NOT NULL`,
    orElse: () =>
      Effect.gen(function* () {
        const abort = sql.literal(`BEGIN SELECT RAISE(ABORT, 'messages.chapter_id is required'); END`);
        yield* sql`CREATE TRIGGER messages_chapter_required_insert BEFORE INSERT ON messages
          WHEN NEW.chapter_id IS NULL ${abort}`;
        yield* sql`CREATE TRIGGER messages_chapter_required_update BEFORE UPDATE OF chapter_id ON messages
          WHEN NEW.chapter_id IS NULL ${abort}`;
      }),
  });
  yield* sql`CREATE INDEX messages_chapter ON messages (chapter_id, seq)`;

  // A journaled entry whose thread is gone still decodes, with a chapter of its own.
  const chapterOf = (threadId: unknown): string => {
    const id = String(threadId);
    const known = chapters.get(id);
    if (known !== undefined) return known;
    const made = crypto.randomUUID();
    chapters.set(id, made);
    return made;
  };
  for (const rewrite of REWRITES) {
    let sequence = 0;
    for (;;) {
      const events = yield* sql<{ sequence: unknown; payload: string }>`SELECT sequence, payload FROM event_journal
        WHERE type = ${rewrite.type} AND schema_version < ${rewrite.version} AND sequence > ${sequence}
        ORDER BY sequence LIMIT ${PAGE}`;
      for (const event of events) {
        const payload = rewrite.change(JSON.parse(event.payload) as Stored, chapterOf);
        yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(payload)}, schema_version = ${rewrite.version}
          WHERE sequence = ${event.sequence}`;
      }
      if (events.length < PAGE) break;
      sequence = Number(events[events.length - 1]?.sequence);
    }
  }
});
