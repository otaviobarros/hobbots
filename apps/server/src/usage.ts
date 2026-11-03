import { runtimeAdapters } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { RuntimeKind, unreportedPlan } from "@hobbots/domain";
import { UsageLedger } from "@hobbots/persistence";
import { DateTime, Duration, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// The Usage screen's report (OP-002): every hob's replies over the period from the usage they
// recorded, and every runtime's plan as its adapter reports it. A runtime that reports no plan, or
// that this hub has no adapter for, is listed as unreported, never estimated.
export const UsageHandlers = HttpApiBuilder.group(HobbotsApi, "usage", (handlers) =>
  Effect.gen(function* () {
    const ledger = yield* UsageLedger;
    const adapters = yield* runtimeAdapters;
    const plans = Effect.forEach(
      RuntimeKind.literals,
      (kind) => adapters(kind)?.planUsage ?? Effect.succeed(unreportedPlan(kind)),
      { concurrency: "unbounded" },
    );
    return handlers.handleAll({
      usage: ({ query }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const until = DateTime.formatIso(now);
          const since = DateTime.formatIso(DateTime.subtractDuration(now, Duration.days(Number(query.days))));
          const [used, reported] = yield* Effect.all([ledger.usage(since, until), plans], { concurrency: 2 });
          return { since, until, hobs: used.hobs, hours: used.hours, plans: reported };
        }),
    });
  }),
).pipe(Layer.provide(UsageLedger.layer));
