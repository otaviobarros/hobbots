import { blockedSiteOf, foundAgent, HobbotsRepository, WebRecords, WebTools, webAnnouncer } from "@hobbots/agents";
import { HobbotsApi, InvalidWebSettings, WEB_USAGE_LIST_MAX } from "@hobbots/api";
import {
  type AgentId,
  BUSIEST_WEB_TURNS,
  DEFAULT_WEB_SETTINGS,
  effectiveWebLimits,
  NO_HOB_WEB_LIMITS,
  reachedTurnLimit,
  type WebLimits,
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

const NO_USAGE = { searches: 0, pages: 0, bytes: 0, tokens: 0, billed: [] };

/** The turns that searched and read the most, searches first, then pages, then the newest. */
const busiestFirst = (
  a: { readonly searches: number; readonly pages: number; readonly at: string },
  b: { readonly searches: number; readonly pages: number; readonly at: string },
) => b.searches - a.searches || b.pages - a.pages || b.at.localeCompare(a.at);

/** How many records a usage read lists unless it asks for fewer. */
const DEFAULT_LIST = 50;

// Settings › Web and what hobs searched and read (ADR 036, Usage and limits), for user sessions only.
export const WebHandlers = HttpApiBuilder.group(HobbotsApi, "web", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    // A hub without web records, as in some tests, keeps the defaults and has nothing to count.
    const records = yield* Effect.serviceOption(WebRecords);
    // A hub that reads no pages, as in some tests, holds none.
    const cache = Option.flatMapNullishOr(yield* Effect.serviceOption(WebTools), (tools) => tools.cache);
    const held = Option.isSome(cache) ? cache.value.held : Effect.succeed({ pages: 0, bytes: 0 });
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
      usageSummary: ({ query }) =>
        Effect.gen(function* () {
          if (Option.isNone(records)) {
            return { since: query.since, totals: pricedWebUsage(NO_USAGE), hobs: [], busiestTurns: [], turns: 0 };
          }
          const read = yield* records.value.usageSince(query.since);
          const shared = yield* settings;
          // Each hob's limits as they are now, read once.
          const limits = new Map<AgentId, WebLimits>();
          for (const hob of read.hobs) {
            limits.set(hob.agentId, effectiveWebLimits(shared, yield* records.value.hobLimits(hob.agentId)));
          }
          const limitOf = (agentId: AgentId) => limits.get(agentId) ?? shared.limits;
          const atLimit = new Map<AgentId, number>();
          for (const turn of read.turns) {
            if (reachedTurnLimit(turn, limitOf(turn.agentId)) !== null) {
              atLimit.set(turn.agentId, (atLimit.get(turn.agentId) ?? 0) + 1);
            }
          }
          const busiest = [...read.turns].sort(busiestFirst).slice(0, BUSIEST_WEB_TURNS);
          const busiestTurns = yield* Effect.forEach(busiest, (turn) =>
            Effect.gen(function* () {
              const thread = turn.threadId === null ? Option.none() : yield* repo.findThread(turn.threadId);
              return {
                ...turn,
                threadTitle: Option.isSome(thread) ? thread.value.title : null,
                reachedLimit: reachedTurnLimit(turn, limitOf(turn.agentId)),
              };
            }),
          );
          return {
            since: query.since,
            totals: pricedWebUsage(read.count),
            hobs: read.hobs
              .map((hob) => ({ ...hob, turnsAtLimit: atLimit.get(hob.agentId) ?? 0 }))
              .sort((a, b) => b.searches - a.searches || b.pages - a.pages),
            busiestTurns,
            turns: read.turns.length,
          };
        }),
      pageCache: () => held,
      clearPageCache: () => (Option.isSome(cache) ? Effect.andThen(cache.value.clear, held) : held),
      usage: ({ query }) =>
        Effect.gen(function* () {
          const { limit, ...filter } = query;
          if (Option.isNone(records)) {
            return {
              totals: pricedWebUsage(NO_USAGE),
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
