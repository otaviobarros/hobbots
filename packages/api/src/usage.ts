import { UsagePeriod, UsageReport } from "@hobbots/domain";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

export class UsageGroup extends HttpApiGroup.make("usage")
  .add(
    // What each hob's replies used over the last 7 or 30 days, and each runtime's plan (OP-002).
    HttpApiEndpoint.get("usage", "/usage", {
      query: { days: UsagePeriod },
      success: UsageReport,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
