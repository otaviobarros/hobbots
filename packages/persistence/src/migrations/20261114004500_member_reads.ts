import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Each person's read marker is their own (ADR 039, read markers per member; #1454). Migration 0114
// gave every thread's owner the thread's marker, and the hub has kept both since; this moves the
// owner's marker forward to the thread's one last time, never back, and drops the thread's. Unread
// counts, the unread line and catch-up read the member row of the person asking from now on.
//
// Whether a thread is unread is no longer part of a thread, since it differs from person to person,
// so every retained entry that carries a thread loses its `unread` and decodes as the new version
// (ADR 013): `ThreadUpserted` 6, `CampMade` 3, `ChatStartedFresh` 3 and `ChapterMoved` 2.
const PAGE = 500;

type Stored = Record<string, unknown>;

/** Each event type that carries threads, its version without `unread`, and the payload keys that hold them. */
const CARRIERS: ReadonlyArray<readonly [type: string, version: number, keys: ReadonlyArray<string>]> = [
  ["ThreadUpserted", 6, ["thread"]],
  ["CampMade", 3, ["thread"]],
  ["ChatStartedFresh", 3, ["superseded", "chat"]],
  ["ChapterMoved", 2, ["thread", "camp"]],
];

const withoutUnread = (payload: Stored, keys: ReadonlyArray<string>): Stored => {
  const changed = { ...payload };
  for (const key of keys) {
    const thread = payload[key];
    if (thread === null || typeof thread !== "object") continue;
    const { unread: _unread, ...rest } = thread as Stored;
    changed[key] = rest;
  }
  return changed;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE thread_members SET read_revision = (SELECT t.read_revision FROM threads t
      WHERE t.id = thread_members.thread_id)
    WHERE role = 'owner' AND (SELECT t.read_revision FROM threads t WHERE t.id = thread_members.thread_id)
      > COALESCE(read_revision, 0)`;
  yield* sql`ALTER TABLE threads DROP COLUMN read_revision`;

  for (const [type, version, keys] of CARRIERS) {
    let sequence = 0;
    for (;;) {
      const events = yield* sql<{ sequence: unknown; payload: string }>`SELECT sequence, payload FROM event_journal
        WHERE type = ${type} AND schema_version < ${version} AND sequence > ${sequence}
        ORDER BY sequence LIMIT ${PAGE}`;
      for (const event of events) {
        const changed = withoutUnread(JSON.parse(event.payload) as Stored, keys);
        yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(changed)}, schema_version = ${version}
          WHERE sequence = ${event.sequence}`;
      }
      if (events.length < PAGE) break;
      sequence = Number(events[events.length - 1]?.sequence);
    }
  }
});
