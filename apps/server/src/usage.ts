import { runtimeAdapters } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { RuntimeKind, unreportedPlan } from "@hobbots/domain";
import { UsageLedger } from "@hobbots/persistence";
import { DateTime, Duration, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// The Usage screen's report (OP-002): every hob's replies over the period from the usage they
// recorded, and every runtime's plan as its adapter reports it. A runtime that reports no plan, or
// that this hub has no adapter for, is listed as unreported, never estimated.
/**
 * Where the period starts: the client's `since`, the start of its own first day, when it is not after
 * now and no more than two hours before the rolling start (`days` local days span an hour more across
 * a clock change). Otherwise the rolling `days` before now.
 */
export const periodStart = (now: DateTime.Utc, days: number, since: string | undefined): DateTime.Utc => {
  const rolling = DateTime.subtractDuration(now, Duration.days(days));
  const asked = since === undefined ? undefined : DateTime.make(since);
  if (asked === undefined || asked._tag === "None") return rolling;
  const earliest = DateTime.subtractDuration(rolling, Duration.hours(2));
  const start = DateTime.toUtc(asked.value);
  return DateTime.isLessThan(start, earliest) || DateTime.isGreaterThan(start, now) ? rolling : start;
};

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
          const since = DateTime.formatIso(periodStart(now, Number(query.days), query.since));
          const [used, reported] = yield* Effect.all([ledger.usage(since, until), plans], { concurrency: 2 });
          return { since, until, hobs: used.hobs, minutes: used.minutes, plans: reported };
        }),
    });
  }),
).pipe(Layer.provide(UsageLedger.layer));
