import { ChannelMemberRepository } from "@hobbots/agents";
import { ChannelArchived } from "@hobbots/api";
import {
  type Actor,
  isActiveMember,
  MemberRefused,
  planMemberAdd,
  type Channel,
  type ChannelId,
  ChannelMember,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import { unreadMentionsOf } from "./message-mentions.ts";
import { memberUnread, memberUnreadCount } from "./channel-columns.ts";
import {
  insertMember,
  type MemberRow,
  membersFromRows,
  movedMember,
  saveState,
  selectMembers,
} from "./channel-member-rows.ts";

/** The SQL store of channel members, for SQLite and PostgreSQL (migration 0114). */
export const ChannelMemberRepositoryLive = Layer.effect(
  ChannelMemberRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);
    const find = (channelId: ChannelId, actor: Actor) =>
      sql<MemberRow>`SELECT * FROM channel_members
        WHERE channel_id = ${channelId} AND actor_kind = ${actor.kind} AND actor_id = ${actor.id}`.pipe(
        Effect.flatMap(membersFromRows),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
      );
    const readChannel = (channelId: ChannelId) =>
      sql<{
        readonly kind: Channel["kind"];
        readonly archivedAt: string | null;
      }>`SELECT kind, archived_at FROM channels WHERE id = ${channelId}`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.die(`No channel ${channelId}`) : Effect.succeed(row))),
      );
    const add = (channelId: ChannelId, actor: Actor, addedBy: Actor, asMember = false) =>
      change<ChannelMember, MemberRefused | ChannelArchived>((first) =>
        Effect.gen(function* () {
          const channel = yield* readChannel(channelId);
          const members = yield* selectMembers(sql, channelId);
          // Checked in the write's own transaction, so one taken out meanwhile adds no one, and a camp
          // archived meanwhile takes no one.
          if (asMember && channel.archivedAt !== null) {
            return yield* new ChannelArchived({ channelId, archivedAt: channel.archivedAt });
          }
          if (asMember && !isActiveMember(members, addedBy)) {
            return yield* new MemberRefused({ channelId, actor: addedBy, reason: "not-member" });
          }
          const plan = planMemberAdd(channel, members, actor);
          switch (plan._tag) {
            case "refused":
              return yield* new MemberRefused({ channelId, actor, reason: plan.reason });
            case "active":
              return { value: plan.member, events: [] };
            case "return": {
              const member = movedMember(plan.member, { _tag: "Return" }, first);
              yield* saveState(sql, member);
              return { value: member, events: [{ _tag: "ChannelMemberChanged", member }] };
            }
            case "add": {
              const member = new ChannelMember({
                channelId,
                actor,
                role: "member",
                state: "active",
                joinedAt: DateTime.formatIso(yield* DateTime.now),
                addedBy,
                readRevision: null,
                mutedUntil: null,
                revision: first,
              });
              yield* insertMember(sql, member);
              return { value: member, events: [{ _tag: "ChannelMemberAdded", member }] };
            }
          }
        }),
      );
    return ChannelMemberRepository.of({
      list: (channelId) => selectMembers(sql, channelId).pipe(Effect.orDie),
      find: (channelId, actor) => find(channelId, actor).pipe(Effect.orDie),
      add,
      unreadMentions: (actor) => unreadMentionsOf(sql, actor).pipe(Effect.orDie),
      unreadReplies: (actor) =>
        sql<{ readonly channelId: string; readonly count: unknown }>`SELECT channel_id, ${memberUnreadCount(sql)} AS count
          FROM channel_members
          WHERE actor_kind = ${actor.kind} AND actor_id = ${actor.id} AND state = 'active' AND ${memberUnread(sql)}
          ORDER BY ${sql.onDialectOrElse({ pg: () => sql.literal(`channel_id COLLATE "C"`), orElse: () => sql.literal("channel_id") })}`.pipe(
          Effect.map((rows) => rows.map((row) => ({ channelId: row.channelId as ChannelId, count: Number(row.count) }))),
          Effect.orDie,
        ),
    });
  }),
);
