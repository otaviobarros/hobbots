import { CampMembers, HobbotsRepository, ThreadMemberRepository, UserRepository } from "@hobbots/agents";
import { HobbotsApi, MembershipRefused, ThreadNotFound } from "@hobbots/api";
import { type MemberRefused, sameActor, type ThreadId, type User } from "@hobbots/domain";
import { UsageLedger } from "@hobbots/persistence";
import { DateTime, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { periodStart } from "./usage.ts";

// A camp's members and what its hobs spent there today (ADR 039, Members; Status and cost), and
// adding hobs to it or taking them out, for user sessions only (PE-006). The changes are
// `CampMembers`' in packages/agents; the sheet's read is put together here from the hub's records.

const refused = (refusal: MemberRefused) =>
  Effect.fail(new MembershipRefused({ threadId: refusal.threadId, actor: refusal.actor, reason: refusal.reason }));

export const MembersHandlers = HttpApiBuilder.group(HobbotsApi, "members", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const ledger = yield* UsageLedger;
    // A hub built without members or users, as in tests of one part, lists the camp's floor alone
    // and changes no one.
    const members = yield* Effect.serviceOption(ThreadMemberRepository);
    const users = yield* Effect.serviceOption(UserRepository);
    const camps = Option.getOrElse(yield* Effect.serviceOption(CampMembers), () =>
      CampMembers.of({
        add: () => Effect.die(new Error("This hub changes no camp's members.")),
        remove: () => Effect.die(new Error("This hub changes no camp's members.")),
      }),
    );

    const list = (threadId: ThreadId, asked: string) =>
      Effect.gen(function* () {
        if (Option.isNone(yield* repo.findThread(threadId))) return yield* new ThreadNotFound({ threadId });
        const now = yield* DateTime.now;
        const until = DateTime.formatIso(now);
        const since = DateTime.formatIso(periodStart(now, 1, asked));
        const all = Option.isSome(members) ? yield* members.value.list(threadId) : [];
        // The people the sheet names: those in the camp.
        const named = all.map((member) => member.actor);
        const known = Option.isSome(users) ? yield* users.value.list : [];
        const people: ReadonlyArray<User> = known.filter((user) =>
          named.some((actor) => sameActor(actor, { kind: "user", id: user.id })),
        );
        // Every hob that answered here today, a member or not: replies that moved in with a chapter
        // count toward the camp's total even when their hob is not in it.
        const today = yield* ledger.threadUsage(threadId, since, until);
        return { threadId, members: all, people, today, since, until };
      });

    return handlers.handleAll({
      list: ({ params, query }) => list(params.threadId, query.since),
      add: ({ params, payload }) =>
        camps.add(params.threadId, payload.actor).pipe(Effect.catchTag("MemberRefused", refused)),
      remove: ({ params }) =>
        camps
          .remove(params.threadId, { kind: params.kind, id: params.id })
          .pipe(Effect.catchTag("MemberRefused", refused)),
    });
  }),
).pipe(Layer.provide(UsageLedger.layer));
