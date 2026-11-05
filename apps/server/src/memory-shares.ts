import { MemoryReviews, MemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import { HobbotsApi, type MemoryCheck, MemoryNotAnswering, MemoryShareNotFound } from "@hobbots/api";
import type { MemoryActor } from "@hobbots/domain";
import { makeMemoryStoreOff } from "@hobbots/memory";
import { DateTime, Effect, Option, Ref } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/**
 * What hobs ask to share, your decisions on it, and Check now (ADR 028, Sharing). A hub without
 * memory tools has no shares: the list is empty and a decision finds none. Check now looks at every
 * scope that holds a page and keeps what it found for Memory › To review, never the Inbox.
 */

const YOU: MemoryActor = { _tag: "You" };

export const MemorySharesHandlers = HttpApiBuilder.group(HobbotsApi, "memoryShares", (handlers) =>
  Effect.gen(function* () {
    const reviews = yield* Effect.serviceOption(MemoryReviews);
    const store: MemoryStoreShape = Option.getOrElse(yield* Effect.serviceOption(MemoryStore), () =>
      makeMemoryStoreOff("This hub has no memory."),
    );
    const lastCheck = yield* Ref.make<MemoryCheck>({ checkedAt: null, findings: [] });
    const none = (shareId: string) => Effect.fail(new MemoryShareNotFound({ shareId }));
    return handlers.handleAll({
      list: () =>
        Option.isSome(reviews)
          ? Effect.map(reviews.value.list, (shares) => ({ shares }))
          : Effect.succeed({ shares: [] }),
      share: ({ params, payload }) =>
        Option.isSome(reviews) ? reviews.value.share(params.shareId, payload.markdown) : none(params.shareId),
      keep: ({ params }) => (Option.isSome(reviews) ? reviews.value.keep(params.shareId) : none(params.shareId)),
      undo: ({ params }) => (Option.isSome(reviews) ? reviews.value.undo(params.shareId) : none(params.shareId)),
      lastCheck: () => Ref.get(lastCheck),
      check: () =>
        Effect.gen(function* () {
          const scopes = yield* store.scopes(YOU);
          const found = yield* Effect.forEach(scopes, (scope) => store.check(YOU, scope), { concurrency: 4 });
          const checked: MemoryCheck = {
            checkedAt: DateTime.formatIso(yield* DateTime.now),
            findings: found.flat(),
          };
          yield* Ref.set(lastCheck, checked);
          return checked;
        }).pipe(Effect.catchTag("MemoryUnavailable", () => Effect.fail(new MemoryNotAnswering()))),
    });
  }),
);
