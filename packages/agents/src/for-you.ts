import { type Actor, type Artifact, type ForYou, type ForYouThread, forYouOf, type ThreadId } from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { ApprovalRepository } from "./approvals.ts";
import { HubQuestions } from "./hub-questions.ts";
import { TaskRepository } from "./tasks.ts";
import { hubOwner, sessionActor } from "./users.ts";

/**
 * For you (ADR 039, Cards every thread shares): one list per person of what is theirs to act on,
 * topped by "While you were away", worked out on the hub by the pure `forYouOf` from the records and
 * the person's read markers. It reads the session's user, never a fixed owner, and makes no model
 * call, so a request for it costs a few queries.
 */

/** What For you reads besides approvals, questions and hub questions. */
export class ForYouRepository extends Context.Service<
  ForYouRepository,
  {
    /**
     * The threads `actor` is an active member of, each with their read marker and the records the
     * away summary reads past it: the messages that mention them, the decisions and artifacts
     * written since, and the thread's Quests when any changed since. A thread with nothing past the
     * marker comes with no records.
     */
    readonly threads: (actor: Actor) => Effect.Effect<ReadonlyArray<ForYouThread>>;
    /** Each thread's owner member, who decides what nobody else asked for. */
    readonly owners: Effect.Effect<ReadonlyMap<ThreadId, Actor>>;
    /** Every artifact still waiting for review. */
    readonly waitingReviews: Effect.Effect<ReadonlyArray<Artifact>>;
  }
>()("@hobbots/agents/ForYouRepository") {}

export class ForYouList extends Context.Service<ForYouList, { readonly current: Effect.Effect<ForYou> }>()(
  "@hobbots/agents/ForYouList",
) {
  static readonly layer = Layer.effect(
    ForYouList,
    Effect.gen(function* () {
      const reads = yield* ForYouRepository;
      const approvals = yield* ApprovalRepository;
      const tasks = yield* TaskRepository;
      // A hub built without the hub's own questions, as in some tests, asks none.
      const hubQuestions = yield* Effect.serviceOption(HubQuestions);
      return ForYouList.of({
        current: Effect.gen(function* () {
          const you = yield* sessionActor;
          return forYouOf({
            you,
            hubOwner,
            threads: yield* reads.threads(you),
            owners: yield* reads.owners,
            approvals: yield* approvals.listPending,
            questions: yield* tasks.listWaitingQuestions,
            hubQuestions: Option.isNone(hubQuestions) ? [] : yield* hubQuestions.value.listOpen,
            reviews: yield* reads.waitingReviews,
          });
        }).pipe(Effect.withSpan("ForYouList.current")),
      });
    }),
  );
}
