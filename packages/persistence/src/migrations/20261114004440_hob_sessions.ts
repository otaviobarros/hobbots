import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A runtime session belongs to one hob (ADR 039, #1464): `RuntimeSession` is keyed by thread,
// chapter, runtime and hob, so each hob in a shared thread resumes only its own session. Every thread
// had one hob until now, so each session a thread keeps is given its thread's hob, and goes on being
// resumed by it.
//
// Journaled entries get the same field: the sessions of a `ThreadUpserted` (version 6), and of the
// threads of a `CampMade` and a `ChatStartedFresh` (version 3), each take the hob of the thread that
// carries them, so every old entry decodes.

const PAGE = 500;

type Stored = Record<string, unknown>;

/** `thread` with each of its sessions given the thread's hob, where it has none yet. */
const withHob = (thread: Stored): Stored => {
  const sessions = Array.isArray(thread.sessions) ? (thread.sessions as ReadonlyArray<Stored>) : [];
  return { ...thread, sessions: sessions.map((session) => ({ agentId: thread.agentId, ...session })) };
};

/** The rewrites of one journaled event type: the version it reaches and how its payload changes. */
interface Rewrite {
  readonly type: string;
  readonly version: number;
  readonly change: (payload: Stored) => Stored;
}

const REWRITES: ReadonlyArray<Rewrite> = [
  {
    type: "ThreadUpserted",
    version: 6,
    change: (payload) => ({ ...payload, thread: withHob(payload.thread as Stored) }),
  },
  { type: "CampMade", version: 3, change: (payload) => ({ ...payload, thread: withHob(payload.thread as Stored) }) },
  {
    type: "ChatStartedFresh",
    version: 3,
    change: (payload) => ({
      ...payload,
      superseded: withHob(payload.superseded as Stored),
      chat: withHob(payload.chat as Stored),
    }),
  },
];

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();

  let after = "";
  for (;;) {
    const threads = yield* sql<{ id: string; agent_id: string; sessions: string | null }>`SELECT id, agent_id, sessions
      FROM threads WHERE id > ${after} ORDER BY id LIMIT ${PAGE}`;
    for (const thread of threads) {
      const sessions = JSON.parse(thread.sessions ?? "[]") as ReadonlyArray<Stored>;
      if (sessions.length > 0) {
        const keyed = JSON.stringify(sessions.map((session) => ({ agentId: thread.agent_id, ...session })));
        yield* sql`UPDATE threads SET sessions = ${keyed} WHERE id = ${thread.id}`;
      }
    }
    if (threads.length < PAGE) break;
    after = String(threads[threads.length - 1]?.id);
  }

  for (const rewrite of REWRITES) {
    let sequence = 0;
    for (;;) {
      const events = yield* sql<{ sequence: unknown; payload: string }>`SELECT sequence, payload FROM event_journal
        WHERE type = ${rewrite.type} AND schema_version < ${rewrite.version} AND sequence > ${sequence}
        ORDER BY sequence LIMIT ${PAGE}`;
      for (const event of events) {
        const payload = rewrite.change(JSON.parse(event.payload) as Stored);
        yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(payload)}, schema_version = ${rewrite.version}
          WHERE sequence = ${event.sequence}`;
      }
      if (events.length < PAGE) break;
      sequence = Number(events[events.length - 1]?.sequence);
    }
  }
});
