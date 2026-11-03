import { UsagePeriod, UsageReport } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

export class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    // What each hob's replies used over the last 7 or 30 days, and each runtime's plan (OP-002).
    // `since` (ISO 8601) starts the period at the client's own midnight, so its days hold every reply.
    HttpApiEndpoint.get("usage", "/usage", {
      query: { days: UsagePeriod, since: Schema.optionalKey(Schema.String) },
      success: UsageReport,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
