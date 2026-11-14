import { runtimeAdapters, TaskRepository, TurnSlots } from "@hobbots/agents";
import { HobbotsApi, QuestNotFound } from "@hobbots/api";
import {
  DEFAULT_TURN_LIMITS,
  type QuestId,
  questCost,
  RuntimeKind,
  type TurnSlotsReport,
  unreportedPlan,
} from "@hobbots/domain";
import { UsageLedger } from "@hobbots/persistence";
import { DateTime, Duration, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// The Usage screen's report (OP-002): every hob's replies over the period from the usage they
// recorded, and, on its own request, every runtime's plan as its adapter reports it. A runtime that reports no plan, or
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
    const tasks = yield* TaskRepository;
    /** The Quest at the top of a Quest's tree, which its usage counts for. */
    const topQuest = (questId: QuestId) =>
      Effect.gen(function* () {
        let found = yield* tasks.findQuest(questId);
        if (Option.isNone(found)) return yield* new QuestNotFound({ questId });
        // A parent the hub lost leaves the Quest as the top it can find.
        for (let parent = found.value.parentQuestId; parent !== null; ) {
          const above = yield* tasks.findQuest(parent);
          if (Option.isNone(above)) break;
          found = above;
          parent = above.value.parentQuestId;
        }
        return found.value;
      });
    const adapters = yield* runtimeAdapters;
    const plans = Effect.forEach(
      RuntimeKind.literals,
      (kind) => adapters(kind)?.planUsage ?? Effect.succeed(unreportedPlan(kind)),
      { concurrency: "unbounded" },
    );
    // A hub without turn slots, as in tests of one part, limits no turn and reports none.
    const slots = Option.getOrUndefined(yield* Effect.serviceOption(TurnSlots));
    const unlimited: TurnSlotsReport = { limits: DEFAULT_TURN_LIMITS, active: [], waiting: [], usage: "after-turn" };
    const turns = slots === undefined ? Effect.succeed(unlimited) : slots.report;
    return handlers.handleAll({
      usage: ({ query }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const until = DateTime.formatIso(now);
          const since = DateTime.formatIso(periodStart(now, Number(query.days), query.since));
          const used = yield* ledger.usage(since, until);
          return { since, until, hobs: used.hobs, quests: used.quests, minutes: used.minutes };
        }),
      plans: () => plans,
      questCost: ({ params }) =>
        Effect.gen(function* () {
          const top = yield* topQuest(params.questId);
          return questCost(top.id, yield* ledger.spentOn(top.id), top.criteria);
        }),
      turns: () => turns,
      setTurnLimits: ({ payload }) =>
        slots === undefined ? Effect.succeed(unlimited) : Effect.andThen(slots.setLimits(payload), slots.report),
    });
  }),
).pipe(Layer.provide(UsageLedger.layer));
