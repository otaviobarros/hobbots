import { PlanUsage, TurnLimits, TurnSlotsReport, UsagePeriod, UsageReport } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
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
    // How many turns run at once (#1448): the limits per hob, Quest and runtime, the turns that run
    // and those that wait, and why. Limits count turns: runtimes report usage only after a turn.
    HttpApiEndpoint.get("turns", "/usage/turns", { success: TurnSlotsReport }),
  )
  .add(
    // Keeps new turn limits across restarts; turns that fit under them start at once.
    HttpApiEndpoint.put("setTurnLimits", "/usage/turns/limits", { payload: TurnLimits, success: TurnSlotsReport }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
