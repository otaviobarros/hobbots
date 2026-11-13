import { sessionActor } from "@hobbots/agents";
import {
  type Actor,
  type JournaledEvent,
  type MemberEvent,
  type Thread,
  type ThreadId,
  ThreadMember,
  ThreadMembers,
} from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

// The members of each thread (ADR 039, Members; migration 0113). An actor is two columns, as a
// message's author is (0101); PostgreSQL reads BIGINT as a bigint and SQLite as a number.

export interface MemberRow {
  readonly threadId: unknown;
  readonly actorKind: unknown;
  readonly actorId: unknown;
  readonly role: unknown;
  readonly state: unknown;
  readonly joinedAt: unknown;
  readonly addedByKind: unknown;
  readonly addedById: unknown;
  readonly readRevision: unknown;
  readonly mutedUntil: unknown;
  readonly revision: unknown;
}

const decodeMember = Schema.decodeUnknownEffect(ThreadMember);

/** Rows as members, in their order. A row the schema refuses is a defect: the database checks them. */
export const membersFromRows = (rows: ReadonlyArray<MemberRow>) =>
  Effect.forEach(rows, (row) =>
    decodeMember({
      threadId: row.threadId,
      actor: { kind: row.actorKind, id: row.actorId },
      role: row.role,
      state: row.state,
      joinedAt: row.joinedAt,
      addedBy: { kind: row.addedByKind, id: row.addedById },
      readRevision: row.readRevision == null ? null : Number(row.readRevision),
      mutedUntil: row.mutedUntil ?? null,
      revision: Number(row.revision),
    }).pipe(Effect.orDie),
  );

// The owner first, then in the order they joined, ties broken on the actor in byte order.
const memberOrder = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () =>
      sql.literal(
        `CASE WHEN role = 'owner' THEN 0 ELSE 1 END, joined_at, actor_kind COLLATE "C", actor_id COLLATE "C"`,
      ),
    orElse: () => sql.literal("CASE WHEN role = 'owner' THEN 0 ELSE 1 END, joined_at, actor_kind, actor_id"),
  });

export const selectMembers = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<MemberRow>`SELECT * FROM thread_members WHERE thread_id = ${threadId} ORDER BY ${memberOrder(sql)}`.pipe(
    Effect.flatMap(membersFromRows),
  );

export const insertMember = (sql: SqlClient.SqlClient, member: ThreadMember) =>
  sql`INSERT INTO thread_members ${sql.insert({
    thread_id: member.threadId,
    actor_kind: member.actor.kind,
    actor_id: member.actor.id,
    role: member.role,
    state: member.state,
    joined_at: member.joinedAt,
    added_by_kind: member.addedBy.kind,
    added_by_id: member.addedBy.id,
    read_revision: member.readRevision,
    muted_until: member.mutedUntil,
    revision: member.revision,
  })} ON CONFLICT (thread_id, actor_kind, actor_id) DO NOTHING`;

export const saveState = (sql: SqlClient.SqlClient, member: ThreadMember) =>
  sql`UPDATE thread_members SET state = ${member.state}, revision = ${member.revision}
    WHERE thread_id = ${member.threadId} AND actor_kind = ${member.actor.kind} AND actor_id = ${member.actor.id}`;

/**
 * `member` after `event`, at `revision`. Its state allows the event, which the caller read in the same
 * transaction: a refusal is a defect.
 */
export const movedMember = (member: ThreadMember, event: MemberEvent, revision: number): ThreadMember => {
  const next = ThreadMembers.transition(member, event);
  if (!(next instanceof ThreadMember)) {
    throw new Error(`Member ${member.actor.kind}:${member.actor.id} is ${member.state} and cannot take ${event._tag}`);
  }
  return new ThreadMember({ ...next, revision });
};

/** Stores each new member, at journal sequences from `first` on: their `ThreadMemberAdded` events. */
const added = (sql: SqlClient.SqlClient, members: ReadonlyArray<ThreadMember>, first: number) =>
  Effect.forEach(members, (member, index) =>
    Effect.gen(function* () {
      const stored = new ThreadMember({ ...member, revision: first + index });
      yield* insertMember(sql, stored);
      return { _tag: "ThreadMemberAdded", member: stored } as const;
    }),
  );

/**
 * Stores a new thread's first two members, at journal sequences from `first` on, and returns their
 * `ThreadMemberAdded` events, which the change journals after the thread's own (ADR 039): the person
 * whose session made it, with role `owner`, and its hob, both added by that person. With no session
 * it is the hub's own code making the thread, for its owner (`sessionActor`). A retired hob's thread
 * has its hob as a member that left.
 */
export const startMembersIn =
  (sql: SqlClient.SqlClient) =>
  (thread: Thread, first: number): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
    Effect.gen(function* () {
      const owner = yield* sessionActor;
      const [hob] = yield* sql<{ readonly status: string }>`SELECT status FROM agents WHERE id = ${thread.agentId}`;
      const fields = { threadId: thread.id, joinedAt: thread.createdAt, addedBy: owner, readRevision: null };
      const members = [
        new ThreadMember({ ...fields, actor: owner, role: "owner", state: "active", mutedUntil: null }),
        new ThreadMember({
          ...fields,
          actor: { kind: "hob", id: thread.agentId },
          role: "member",
          state: hob?.status === "retired" ? "left" : "active",
          mutedUntil: null,
        }),
      ];
      return yield* added(sql, members, first);
    });

/**
 * Gives the chat Start fresh makes the members of the chat it replaces, as they stand, joined when
 * the new chat was made, at journal sequences from `first` on: a direct message keeps its person and
 * its hob. Returns their `ThreadMemberAdded` events. Read markers start empty, since nothing in the
 * new chat was read yet.
 */
export const copyMembersIn =
  (sql: SqlClient.SqlClient) =>
  (from: ThreadId, to: Thread, first: number): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
    Effect.gen(function* () {
      const members = (yield* selectMembers(sql, from)).map(
        (member) => new ThreadMember({ ...member, threadId: to.id, joinedAt: to.createdAt, readRevision: null }),
      );
      return yield* added(sql, members, first);
    });

/**
 * Moves each person's read marker with their thread's, where the thread's marker moves without them
 * reading, as a chapter that moves keeps a read thread read. Only the owner reads a thread today; the
 * marker becomes each member's own when unread counts move onto it (ADR 039).
 */
export const followThreadReads = (sql: SqlClient.SqlClient, threadIds: ReadonlyArray<ThreadId>) =>
  sql`UPDATE thread_members SET read_revision = (SELECT t.read_revision FROM threads t
      WHERE t.id = thread_members.thread_id)
    WHERE ${sql.in("thread_id", threadIds)} AND role = 'owner'`;

/** Moves `reader`'s marker in the thread forward to `revision`, never back. */
export const markMemberRead = (sql: SqlClient.SqlClient, threadId: ThreadId, reader: Actor, revision: number) =>
  sql`UPDATE thread_members SET read_revision = ${revision}
    WHERE thread_id = ${threadId} AND actor_kind = ${reader.kind} AND actor_id = ${reader.id}
      AND COALESCE(read_revision, 0) < ${revision}`;

/**
 * A hob leaves every thread it is active in when it retires, and comes back to every thread it left
 * when it returns (ADR 039, Members), at journal sequences from `first` on: their
 * `ThreadMemberChanged` events, read from the hob's `AgentUpserted`. Only for use within
 * `sql.withTransaction`, after the change wrote.
 */
export const settleHobMembers = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<JournaledEvent>,
  first: number,
): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const changed: Array<JournaledEvent> = [];
    for (const event of events) {
      if (event._tag !== "AgentUpserted") continue;
      const retired = event.agent.status === "retired";
      const moving = yield* sql<MemberRow>`SELECT * FROM thread_members
        WHERE actor_kind = 'hob' AND actor_id = ${event.agent.id} AND state = ${retired ? "active" : "left"}
        ORDER BY ${memberOrder(sql)}, thread_id`.pipe(Effect.flatMap(membersFromRows));
      for (const member of moving) {
        const moved = movedMember(member, { _tag: retired ? "Leave" : "Return" }, first + changed.length);
        yield* saveState(sql, moved);
        changed.push({ _tag: "ThreadMemberChanged", member: moved });
      }
    }
    return changed;
  });
