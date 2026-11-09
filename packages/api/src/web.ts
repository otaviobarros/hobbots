import {
  AgentId,
  HobWebLimits,
  HobWebLimitsView,
  WebPageCache,
  WebSettings,
  WebSettingsInput,
  WebUsage,
  WebUsageFilter,
  WebUsageSummary,
} from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound } from "./errors.ts";

/** A blocked site that names no host, which Settings › Web cannot keep. */
export class InvalidWebSettings extends Schema.TaggedError<InvalidWebSettings>()(
  "InvalidWebSettings",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

import { DeviceSession } from "./user-session.ts";

/** How many of the newest searches and pages a usage read lists at most; its totals count them all. */
export const WEB_USAGE_LIST_MAX = 200;

/**
 * What hobs searched and read on the web, and Settings › Web (ADR 036, Usage and limits). The totals
 * carry an estimated cost only where a sign-in is billed per search. Only a user session reaches it
 * (PE-006): the limits are yours to set, never a hob's.
 */
export class WebGroup extends HttpApiGroup.make("web")
  .add(
    HttpApiEndpoint.get("settings", "/web/settings", { success: WebSettings }),
    // Blocked sites are kept as hosts: a URL or a `*.` in an entry is cut to its host first, and an
    // entry that names no host is refused.
    HttpApiEndpoint.put("setSettings", "/web/settings", {
      payload: WebSettingsInput,
      success: WebSettings,
      error: InvalidWebSettings,
    }),
    HttpApiEndpoint.get("hobLimits", "/agents/:agentId/web-limits", {
      params: { agentId: AgentId },
      success: HobWebLimitsView,
      error: AgentNotFound,
    }),
    // A null limit follows Settings › Web.
    HttpApiEndpoint.put("setHobLimits", "/agents/:agentId/web-limits", {
      params: { agentId: AgentId },
      payload: HobWebLimits,
      success: HobWebLimitsView,
      error: AgentNotFound,
    }),
    // The searches and pages a filter matches: a hob's, a chat's, a reply's (a turn), a Task's, an
    // Attempt's or a Quest's, since a time when `since` is given.
    HttpApiEndpoint.get("usage", "/web/usage", {
      query: {
        ...WebUsageFilter.fields,
        limit: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: WEB_USAGE_LIST_MAX })),
        ),
      },
      success: WebUsage,
    }),
    // What every hob searched and read since a time, per hob and with the busiest turns, for Usage.
    HttpApiEndpoint.get("usageSummary", "/web/usage/summary", {
      query: { since: Schema.String },
      success: WebUsageSummary,
    }),
    // The pages the hub holds for 15 minutes, shared by every hob, and clearing them.
    HttpApiEndpoint.get("pageCache", "/web/cache", { success: WebPageCache }),
    HttpApiEndpoint.delete("clearPageCache", "/web/cache", { success: WebPageCache }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
