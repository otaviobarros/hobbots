import { ThreadNotFound } from "@hobbots/api";
import { type CatchUp, type CatchUpQuest, catchUpOf, type ThreadId } from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { RecordRepository } from "./records.ts";
import { HobbotsRepository } from "./repository.ts";
import { sessionActor } from "./users.ts";

/**
 * Catch-up (ADR 037): what changed in a chat or camp since you last read it, worked out on the hub
 * from your read marker and the thread's records by the pure `catchUpOf`, so every device shows the
 * same. Read it before the chat marks itself read, since reading moves the marker past it.
 */

/** What catch-up reads besides the transcript and the records. */
export class CatchUpRepository extends Context.Service<
  CatchUpRepository,
  {
    /** The newest message revision you read the thread through, or null when you never read it. */
    readonly marker: (threadId: ThreadId) => Effect.Effect<number | null>;
    /** The Quests followed in the thread, with their summaries and goals. */
    readonly quests: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CatchUpQuest>>;
  }
>()("@hobbots/agents/CatchUpRepository") {}

export class CatchUps extends Context.Service<
  CatchUps,
  { readonly of: (threadId: ThreadId) => Effect.Effect<CatchUp, ThreadNotFound> }
>()("@hobbots/agents/CatchUps") {
  static readonly layer = Layer.effect(
    CatchUps,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const reads = yield* CatchUpRepository;
      // A hub without records, as in some tests, catches up on replies and Quests alone.
      const records = yield* Effect.serviceOption(RecordRepository);
      return CatchUps.of({
        of: Effect.fn("CatchUps.of")(function* (threadId: ThreadId) {
          if (Option.isNone(yield* repo.findThread(threadId))) return yield* new ThreadNotFound({ threadId });
          return catchUpOf({
            you: yield* sessionActor,
            marker: yield* reads.marker(threadId),
            messages: yield* repo.listMessages(threadId),
            decisions: Option.isNone(records) ? [] : yield* records.value.listDecisions(threadId),
            artifacts: Option.isNone(records) ? [] : yield* records.value.listArtifacts(threadId),
            quests: yield* reads.quests(threadId),
          });
        }),
      });
    }),
  );
}
