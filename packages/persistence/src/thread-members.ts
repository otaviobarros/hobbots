import { ThreadMemberRepository } from "@hobbots/agents";
import { type Actor, MemberRefused, planMemberAdd, type Thread, type ThreadId, ThreadMember } from "@hobbots/domain";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import { unreadMentionsOf } from "./message-mentions.ts";
import { memberUnread, memberUnreadCount } from "./thread-columns.ts";
import {
  insertMember,
  type MemberRow,
  membersFromRows,
  movedMember,
  saveState,
  selectMembers,
} from "./thread-member-rows.ts";

/** The SQL store of thread members, for SQLite and PostgreSQL (migration 0114). */
export const ThreadMemberRepositoryLive = Layer.effect(
  ThreadMemberRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);
    const find = (threadId: ThreadId, actor: Actor) =>
      sql<MemberRow>`SELECT * FROM thread_members
        WHERE thread_id = ${threadId} AND actor_kind = ${actor.kind} AND actor_id = ${actor.id}`.pipe(
        Effect.flatMap(membersFromRows),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
      );
    const readThread = (threadId: ThreadId) =>
      sql<{ readonly kind: Thread["kind"] }>`SELECT kind FROM threads WHERE id = ${threadId}`.pipe(
        Effect.flatMap(([row]) => (row === undefined ? Effect.die(`No thread ${threadId}`) : Effect.succeed(row))),
      );
    const known = (actor: Actor): Effect.Effect<boolean, SqlError.SqlError> => {
      if (actor.kind === "hub") return Effect.succeed(false);
      const rows =
        actor.kind === "user"
          ? sql`SELECT 1 AS found FROM users WHERE id = ${actor.id}`
          : sql`SELECT 1 AS found FROM agents WHERE id = ${actor.id}`;
      return Effect.map(rows, (found) => found.length > 0);
    };
    const add = (threadId: ThreadId, actor: Actor, addedBy: Actor) =>
      change<ThreadMember, MemberRefused>((first) =>
        Effect.gen(function* () {
          const thread = yield* readThread(threadId);
          // Only a person or a hob the hub knows joins.
          if (!(yield* known(actor))) return yield* new MemberRefused({ threadId, actor, reason: "unknown" });
          const plan = planMemberAdd(thread, yield* selectMembers(sql, threadId), actor);
          switch (plan._tag) {
            case "refused":
              return yield* new MemberRefused({ threadId, actor, reason: plan.reason });
            case "active":
              return { value: plan.member, events: [] };
            case "return": {
              const member = movedMember(plan.member, { _tag: "Return" }, first);
              yield* saveState(sql, member);
              return { value: member, events: [{ _tag: "ThreadMemberChanged", member }] };
            }
            case "add": {
              const member = new ThreadMember({
                threadId,
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
              return { value: member, events: [{ _tag: "ThreadMemberAdded", member }] };
            }
          }
        }),
      );
    return ThreadMemberRepository.of({
      list: (threadId) => selectMembers(sql, threadId).pipe(Effect.orDie),
      find: (threadId, actor) => find(threadId, actor).pipe(Effect.orDie),
      add,
      unreadMentions: (actor) => unreadMentionsOf(sql, actor).pipe(Effect.orDie),
      unreadReplies: (actor) =>
        sql<{ readonly threadId: string; readonly count: unknown }>`SELECT thread_id, ${memberUnreadCount(sql)} AS count
          FROM thread_members
          WHERE actor_kind = ${actor.kind} AND actor_id = ${actor.id} AND state = 'active' AND ${memberUnread(sql)}
          ORDER BY ${sql.onDialectOrElse({ pg: () => sql.literal(`thread_id COLLATE "C"`), orElse: () => sql.literal("thread_id") })}`.pipe(
          Effect.map((rows) => rows.map((row) => ({ threadId: row.threadId as ThreadId, count: Number(row.count) }))),
          Effect.orDie,
        ),
    });
  }),
);
