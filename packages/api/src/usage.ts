import { PlanUsage, QuestCost, QuestId, TurnSlotsReport, UsagePeriod, UsageReport } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { QuestNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

export class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    // What each hob's replies used over the last 7 or 30 days (OP-002).
    // `since` (ISO 8601) starts the period at the client's own midnight, so its days hold every reply.
    HttpApiEndpoint.get("usage", "/usage", {
      query: { days: UsagePeriod, since: Schema.optionalKey(Schema.String) },
      success: UsageReport,
    }),
  )
  .add(
    // Each runtime's plan as it reports it (OP-002). It has its own request because asking a runtime
    // for its plan starts it and can take seconds, while the report above reads only the hub.
    HttpApiEndpoint.get("plans", "/usage/plans", {
      success: Schema.Array(PlanUsage),
    }),
  )
  .add(
    // How many turns run at once (#1590): the hub's cap, the turns that run and those that wait. The
    // cap counts turns: runtimes report usage only after a turn.
    HttpApiEndpoint.get("turns", "/usage/turns", { success: TurnSlotsReport }),
  )
  .add(
    // What a Quest cost (#1449): what its whole party used, from the same records as the report
    // above. A sub-quest answers for its top Quest.
    HttpApiEndpoint.get("questCost", "/quests/:questId/cost", {
      params: { questId: QuestId },
      success: QuestCost,
      error: [QuestNotFound],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
