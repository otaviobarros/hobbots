import { blockedSiteOf, foundAgent, HobbotsRepository, WebRecords, webAnnouncer } from "@hobbots/agents";
import { HobbotsApi, InvalidWebSettings, WEB_USAGE_LIST_MAX } from "@hobbots/api";
import {
  type AgentId,
  DEFAULT_WEB_SETTINGS,
  effectiveWebLimits,
  NO_HOB_WEB_LIMITS,
  type WebSettings,
  type WebSettingsInput,
  type WebUsageFilter,
} from "@hobbots/domain";
import { pricedWebUsage } from "@hobbots/web-access";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/**
 * Settings › Web as they are kept: each blocked site a host, once, in the order you gave them. An
 * empty entry is dropped, and one that names no host is refused.
 */
const keptWebSettings = (settings: WebSettingsInput) =>
  Effect.gen(function* () {
    const sites: Array<string> = [];
    for (const raw of settings.blockedSites) {
      if (raw.trim() === "") continue;
      const site = blockedSiteOf(raw);
      if (site === null) return yield* new InvalidWebSettings({ message: `${raw.trim()} is not a site's name.` });
      if (!sites.includes(site)) sites.push(site);
    }
    return { limits: settings.limits, blockedSites: sites } satisfies WebSettings;
  });

/** How many records a usage read lists unless it asks for fewer. */
const DEFAULT_LIST = 50;

// Settings › Web and what hobs searched and read (ADR 036, Usage and limits), for user sessions only.
export const WebHandlers = HttpApiBuilder.group(HobbotsApi, "web", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    // A hub without web records, as in some tests, keeps the defaults and has nothing to count.
    const records = yield* Effect.serviceOption(WebRecords);
    const announce = yield* webAnnouncer;
    const settings = Option.isSome(records) ? records.value.settings : Effect.succeed(DEFAULT_WEB_SETTINGS);
    const hob = (agentId: AgentId) => repo.findAgent(agentId).pipe(Effect.flatMap(foundAgent(agentId)));
    const view = (agentId: AgentId) =>
      Effect.gen(function* () {
        const overrides = Option.isSome(records) ? yield* records.value.hobLimits(agentId) : NO_HOB_WEB_LIMITS;
        return { agentId, overrides, effective: effectiveWebLimits(yield* settings, overrides) };
      });
    return handlers.handleAll({
      settings: () => settings,
      setSettings: ({ payload }) =>
        Effect.gen(function* () {
          const kept = yield* keptWebSettings(payload);
          if (Option.isSome(records)) yield* Effect.flatMap(records.value.setSettings(kept), announce);
          return kept;
        }),
      hobLimits: ({ params }) => Effect.andThen(hob(params.agentId), view(params.agentId)),
      setHobLimits: ({ params, payload }) =>
        Effect.gen(function* () {
          yield* hob(params.agentId);
          if (Option.isSome(records))
            yield* Effect.flatMap(records.value.setHobLimits(params.agentId, payload), announce);
          return yield* view(params.agentId);
        }),
      usage: ({ query }) =>
        Effect.gen(function* () {
          const { limit, ...filter } = query;
          if (Option.isNone(records)) {
            return {
              totals: pricedWebUsage({ searches: 0, pages: 0, bytes: 0, tokens: 0, billed: [] }),
              searches: [],
              pages: [],
            };
          }
          const read = yield* records.value.usage(
            filter satisfies WebUsageFilter,
            Math.min(limit ?? DEFAULT_LIST, WEB_USAGE_LIST_MAX),
          );
          return { totals: pricedWebUsage(read.count), searches: read.searches, pages: read.pages };
        }),
    });
  }),
);
