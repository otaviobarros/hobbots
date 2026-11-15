import { sessionActor } from "@hobbots/agents";
import { HobUnavailable } from "@hobbots/api";
import {
  type Actor,
  AgentId,
  type Channel,
  type ChannelId,
  ChannelMember,
  ChannelMembers,
  type JournaledEvent,
  type MemberEvent,
} from "@hobbots/domain";
import { Effect, Option, Schema } from "effect";
import type { SqlClient, SqlError, Statement } from "effect/sql";
import { memberUnread } from "./channel-columns.ts";

// The members of each channel (ADR 039, Members; migration 0114). An actor is two columns, as a
// message's author is (0101); PostgreSQL reads BIGINT as a bigint and SQLite as a number.

export interface MemberRow {
  readonly channelId: unknown;
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

const decodeMember = Schema.decodeUnknownEffect(ChannelMember);

/** Rows as members, in their order. A row the schema refuses is a defect: the database checks them. */
export const membersFromRows = (rows: ReadonlyArray<MemberRow>) =>
  Effect.forEach(rows, (row) =>
    decodeMember({
      channelId: row.channelId,
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

export const selectMembers = (sql: SqlClient.SqlClient, channelId: ChannelId) =>
  sql<MemberRow>`SELECT * FROM channel_members WHERE channel_id = ${channelId} ORDER BY ${memberOrder(sql)}`.pipe(
    Effect.flatMap(membersFromRows),
  );

export const insertMember = (sql: SqlClient.SqlClient, member: ChannelMember) =>
  sql`INSERT INTO channel_members ${sql.insert({
    channel_id: member.channelId,
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
  })} ON CONFLICT (channel_id, actor_kind, actor_id) DO NOTHING`;

export const saveState = (sql: SqlClient.SqlClient, member: ChannelMember) =>
  sql`UPDATE channel_members SET state = ${member.state}, revision = ${member.revision}
    WHERE channel_id = ${member.channelId} AND actor_kind = ${member.actor.kind} AND actor_id = ${member.actor.id}`;

/**
 * `member` after `event`, at `revision`. Its state allows the event, which the caller read in the same
 * transaction: a refusal is a defect.
 */
export const movedMember = (member: ChannelMember, event: MemberEvent, revision: number): ChannelMember => {
  const next = ChannelMembers.transition(member, event);
  if (!(next instanceof ChannelMember)) {
    throw new Error(`Member ${member.actor.kind}:${member.actor.id} is ${member.state} and cannot take ${event._tag}`);
  }
  return new ChannelMember({ ...next, revision });
};

/** Stores each new member, at journal sequences from `first` on: their `ChannelMemberAdded` events. */
const added = (sql: SqlClient.SqlClient, members: ReadonlyArray<ChannelMember>, first: number) =>
  Effect.forEach(members, (member, index) =>
    Effect.gen(function* () {
      const stored = new ChannelMember({ ...member, revision: first + index });
      yield* insertMember(sql, stored);
      return { _tag: "ChannelMemberAdded", member: stored } as const;
    }),
  );

/**
 * Stores a new channel's first two members, at journal sequences from `first` on, and returns their
 * `ChannelMemberAdded` events, which the change journals after the channel's own (ADR 039): the person
 * whose session made it, with role `owner`, and its hob, both added by that person. With no session
 * it is the hub's own code making the channel, for its owner (`sessionActor`). A retired hob's channel
 * has its hob as a member that left.
 */
export const startMembersIn =
  (sql: SqlClient.SqlClient) =>
  (channel: Channel, first: number): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
    Effect.gen(function* () {
      const owner = yield* sessionActor;
      const [hob] = yield* sql<{ readonly status: string }>`SELECT status FROM agents WHERE id = ${channel.ownerHobId}`;
      const fields = { channelId: channel.id, joinedAt: channel.createdAt, addedBy: owner, readRevision: null };
      const members = [
        new ChannelMember({ ...fields, actor: owner, role: "owner", state: "active", mutedUntil: null }),
        new ChannelMember({
          ...fields,
          actor: { kind: "hob", id: channel.ownerHobId },
          role: "member",
          state: hob?.status === "retired" ? "left" : "active",
          mutedUntil: null,
        }),
      ];
      return yield* added(sql, members, first);
    });

/** A hob's standing for new work, as its row stores it. */
interface AgentStanding {
  readonly id: string;
  readonly status: "active" | "paused" | "retired";
  readonly retiring: string | null;
}

/**
 * Adds the other hobs a camp is made with (ADR 039, Members), after its first two members, at journal
 * sequences from `first` on, each added by the person whose session made it: their
 * `ChannelMemberAdded` events. A hob paused, retiring or retired since it was picked is refused
 * `HobUnavailable`, so the camp is not made.
 */
export const addHobsIn =
  (sql: SqlClient.SqlClient) =>
  (
    channel: Channel,
    hobs: ReadonlyArray<AgentId>,
    first: number,
  ): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError | HobUnavailable> =>
    Effect.gen(function* () {
      if (hobs.length === 0) return [];
      const owner = yield* sessionActor;
      // Read in the camp's own transaction, so a hob paused or retired since it was picked is refused
      // here and the camp is not made, rather than joining with work it no longer takes. On PostgreSQL
      // the rows stay locked until the camp commits, so a pause waits for it.
      const rows = yield* sql.onDialectOrElse({
        pg: () => sql<AgentStanding>`SELECT id, status, retiring FROM agents WHERE ${sql.in("id", hobs)} FOR UPDATE`,
        orElse: () => sql<AgentStanding>`SELECT id, status, retiring FROM agents WHERE ${sql.in("id", hobs)}`,
      });
      const unavailable = rows.find((row) => row.status !== "active" || row.retiring !== null);
      if (unavailable !== undefined) {
        const status = unavailable.status === "active" ? "retiring" : unavailable.status;
        return yield* new HobUnavailable({ agentId: AgentId.make(unavailable.id), status });
      }
      const members = hobs.map(
        (hobId) =>
          new ChannelMember({
            channelId: channel.id,
            actor: { kind: "hob", id: hobId },
            role: "member",
            state: "active",
            joinedAt: channel.createdAt,
            addedBy: owner,
            readRevision: null,
            mutedUntil: null,
            revision: first,
          }),
      );
      return yield* added(sql, members, first);
    });

/**
 * Gives the chat Start fresh makes the members of the chat it replaces, as they stand, joined when
 * the new chat was made, at journal sequences from `first` on: a direct message keeps its person and
 * its hob. Returns their `ChannelMemberAdded` events. Read markers start empty, since nothing in the
 * new chat was read yet.
 */
export const copyMembersIn =
  (sql: SqlClient.SqlClient) =>
  (from: ChannelId, to: Channel, first: number): Effect.Effect<ReadonlyArray<JournaledEvent>, SqlError.SqlError> =>
    Effect.gen(function* () {
      const members = (yield* selectMembers(sql, from)).map(
        (member) => new ChannelMember({ ...member, channelId: to.id, joinedAt: to.createdAt, readRevision: null }),
      );
      return yield* added(sql, members, first);
    });

/**
 * Keeps every person who had read the channel read where its messages take revision `revision`
 * without them reading, as when a chapter moves (ADR 037): their marker moves to it. Someone with a
 * reply unread keeps it unread, and a hob reads nothing (ADR 039, read markers per member).
 */
export const keepReadersRead = (sql: SqlClient.SqlClient, channelIds: ReadonlyArray<ChannelId>, revision: number) =>
  sql`UPDATE channel_members SET read_revision = ${revision}
    WHERE ${sql.in("channel_id", channelIds)} AND actor_kind = 'user' AND NOT ${memberUnread(sql)}`;

/**
 * Moves `reader`'s marker in the channel forward to `seen` at `revision`, never back, and returns
 * their row as it is now; none when it did not move, or they are not a member.
 */
export const markMemberRead = (
  sql: SqlClient.SqlClient,
  channelId: ChannelId,
  reader: Actor,
  seen: Statement.Fragment,
  revision: number,
) =>
  sql<MemberRow>`UPDATE channel_members SET read_revision = ${seen}, revision = ${revision}
    WHERE channel_id = ${channelId} AND actor_kind = ${reader.kind} AND actor_id = ${reader.id}
      AND ${seen} > COALESCE(read_revision, 0)
    RETURNING *`.pipe(
    Effect.flatMap(membersFromRows),
    Effect.map((rows) => Option.fromNullishOr(rows[0])),
  );

/**
 * A hob leaves every channel it is active in when it retires, and comes back to every channel it left
 * when it returns (ADR 039, Members), at journal sequences from `first` on: their
 * `ChannelMemberChanged` events, read from the hob's `AgentUpserted`. Only for use within
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
      const moving = yield* sql<MemberRow>`SELECT * FROM channel_members
        WHERE actor_kind = 'hob' AND actor_id = ${event.agent.id} AND state = ${retired ? "active" : "left"}
        ORDER BY ${memberOrder(sql)}, channel_id`.pipe(Effect.flatMap(membersFromRows));
      for (const member of moving) {
        const moved = movedMember(member, { _tag: retired ? "Leave" : "Return" }, first + changed.length);
        yield* saveState(sql, moved);
        changed.push({ _tag: "ChannelMemberChanged", member: moved });
      }
    }
    return changed;
  });
