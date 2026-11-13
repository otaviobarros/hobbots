import { ThreadMemberRepository } from "@hobbots/agents";
import { type Actor, MemberRefused, planMemberAdd, type Thread, type ThreadId, ThreadMember } from "@hobbots/domain";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { makeJournaledChange } from "./journal.ts";
import {
  insertMember,
  type MemberRow,
  membersFromRows,
  movedMember,
  saveState,
  selectMembers,
} from "./thread-member-rows.ts";

/** The SQL store of thread members, for SQLite and PostgreSQL (migration 0113). */
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
    const add = (threadId: ThreadId, actor: Actor, addedBy: Actor) =>
      change<ThreadMember, MemberRefused>((first) =>
        Effect.gen(function* () {
          const thread = yield* readThread(threadId);
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
    });
  }),
);
