import { type Actor, isInProgress, type Message, mentionsIn, sameActor, type ThreadId } from "@hobbots/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

// The hobs and people each message @mentions (ADR 039, Who answers; migration 20261114003022), stored as JSON
// on the message, and the mentions of one person that they have not read yet.

/** Each actor of `later` not already in `earlier`, after them: earlier mentions keep their place. */
export const joinedMentions = (earlier: ReadonlyArray<Actor>, later: ReadonlyArray<Actor>) => [
  ...earlier,
  ...later.filter((actor) => !earlier.some((seen) => sameActor(seen, actor))),
];

const parse = (sql: SqlClient.SqlClient, text: string, after: number) =>
  Effect.gen(function* () {
    const hobs = yield* sql<{ readonly id: string; readonly name: string }>`SELECT id, name FROM agents`;
    const people = yield* sql<{ readonly id: string; readonly name: string }>`SELECT id, name FROM users`;
    return mentionsIn(
      text,
      [
        ...hobs.map((row) => ({ actor: { kind: "hob" as const, id: row.id }, name: row.name })),
        ...people.map((row) => ({ actor: { kind: "user" as const, id: row.id }, name: row.name })),
      ],
      after,
    );
  });

/** A message's mentions as stored, and how much of its text, in UTF-16 code units, they were parsed from. */
export interface StoredMentions {
  readonly mentions: ReadonlyArray<Actor>;
  readonly through: number;
}

/**
 * The mentions to store with the message, and how much of its text they were parsed from. Text is
 * parsed when it is stored final: as a message is sent, or when a reply ends. A reply still streaming
 * keeps what it had: none on its first turn, and after Continue, those of the text it kept. Text is
 * parsed once: a reply that ends again with more text keeps its mentions, as they were decided
 * against the roster of then, and adds after them those of the text past what was parsed. So a hob
 * renamed later never changes what a stored message mentions. The roster is every hob and person of
 * the hub, so a mention of a hob outside the thread is kept, for who answers to refuse.
 */
export const mentionsToStore = (
  sql: SqlClient.SqlClient,
  message: Message,
): Effect.Effect<StoredMentions, SqlError.SqlError> =>
  Effect.gen(function* () {
    const [stored] = yield* sql<{ readonly mentions: string; readonly mentionsThrough: unknown }>`SELECT mentions,
      mentions_through FROM messages WHERE id = ${message.id}`;
    const had: ReadonlyArray<Actor> = stored === undefined ? message.mentions : JSON.parse(stored.mentions);
    const through = stored === undefined ? 0 : Number(stored.mentionsThrough);
    if (isInProgress(message.status) || through >= message.content.length) return { mentions: had, through };
    const found = message.content.includes("@") ? yield* parse(sql, message.content, through) : [];
    return { mentions: joinedMentions(had, found), through: message.content.length };
  });

/**
 * Whether message `m` mentions the actor: the actor's JSON is one element of `m.mentions`. SQLite
 * reads the array with `json_each`, PostgreSQL with `jsonb` containment.
 */
const mentionsActor = (sql: SqlClient.SqlClient, actor: Actor) =>
  sql.onDialectOrElse({
    pg: () =>
      sql`m.mentions::jsonb @> jsonb_build_array(jsonb_build_object('kind', ${actor.kind}::text, 'id', ${actor.id}::text))`,
    orElse: () => sql`EXISTS (SELECT 1 FROM json_each(m.mentions) j
      WHERE json_extract(j.value, '$.kind') = ${actor.kind} AND json_extract(j.value, '$.id') = ${actor.id})`,
  });

/**
 * How many messages mention the actor that they have not read, per thread they are an active member
 * of, for threads with any (ADR 039, Users as actors: mentions of you are per person). A message
 * counts once it is past the member's read marker; your own messages, notes to self and a lead's quiet
 * progress never count. Threads in byte order of their id.
 */
export const unreadMentionsOf = (sql: SqlClient.SqlClient, actor: Actor) =>
  sql<{ readonly threadId: string; readonly count: unknown }>`SELECT m.thread_id, COUNT(*) AS count
    FROM messages m
    JOIN thread_members tm ON tm.thread_id = m.thread_id
      AND tm.actor_kind = ${actor.kind} AND tm.actor_id = ${actor.id} AND tm.state = 'active'
    WHERE m.revision > COALESCE(tm.read_revision, 0) AND m.role <> 'note' AND m.quiet = 0
      AND NOT (m.actor_kind = ${actor.kind} AND m.actor_id = ${actor.id})
      AND ${mentionsActor(sql, actor)}
    GROUP BY m.thread_id
    ORDER BY ${sql.onDialectOrElse({ pg: () => sql.literal(`m.thread_id COLLATE "C"`), orElse: () => sql.literal("m.thread_id") })}`.pipe(
    Effect.map((rows) => rows.map((row) => ({ threadId: row.threadId as ThreadId, count: Number(row.count) }))),
  );
