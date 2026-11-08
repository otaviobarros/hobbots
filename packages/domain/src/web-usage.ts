import { Schema } from "effect";
import { RuntimeKind } from "./agent.ts";
import { AgentId, MessageId, TaskId, ThreadId } from "./ids.ts";
import { QuestId } from "./quest.ts";
import { AttemptId } from "./task.ts";

/**
 * What hobs searched and read on the web, and the limits on it (ADR 036, Usage and limits): one record
 * per search a runtime reported and per page `web_fetch` read, counted per turn, Task, Quest and hob,
 * and the limits the hub enforces, set in Settings › Web with per-hob overrides.
 */

/** A count a limit allows: a whole number from 0, where 0 allows none. */
const LimitCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100_000));

/** The limits on a hob's web use. Each applies to every runtime; how it is enforced differs (ADR 036). */
export const WebLimits = Schema.Struct({
  /** Searches one turn may run. */
  searchesPerTurn: LimitCount,
  /** Pages one turn may read with `web_fetch`. */
  pagesPerTurn: LimitCount,
  /** Searches one hob may run in a day (the last 24 hours). */
  searchesPerDay: LimitCount,
});
export type WebLimits = typeof WebLimits.Type;

export const DEFAULT_WEB_LIMITS: WebLimits = { searchesPerTurn: 10, pagesPerTurn: 30, searchesPerDay: 200 };

/** The most sites the blocked list holds. */
export const BLOCKED_SITES_MAX = 500;

/**
 * A site `web_fetch` refuses: a host name such as `example.com`, lowercase, which also blocks every
 * name under it, such as `docs.example.com`.
 */
export const BlockedSite = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(253),
  Schema.isPattern(/^(?=.*[a-z0-9])[a-z0-9.-]+$/),
);

/** Settings › Web: the limits every hob has unless its own override says otherwise, and the blocked sites. */
export const WebSettings = Schema.Struct({
  limits: WebLimits,
  /** Sites `web_fetch` refuses. A search cannot be filtered by it: the provider chooses what it finds. */
  blockedSites: Schema.Array(BlockedSite).check(Schema.isMaxLength(BLOCKED_SITES_MAX)),
});
export type WebSettings = typeof WebSettings.Type;

/** Settings › Web as you send them: each blocked site as you typed it, a URL or `*.example.com` too. */
export const WebSettingsInput = Schema.Struct({
  limits: WebLimits,
  blockedSites: Schema.Array(Schema.String.check(Schema.isMaxLength(2_000))).check(
    Schema.isMaxLength(BLOCKED_SITES_MAX),
  ),
});
export type WebSettingsInput = typeof WebSettingsInput.Type;

export const DEFAULT_WEB_SETTINGS: WebSettings = { limits: DEFAULT_WEB_LIMITS, blockedSites: [] };

/** A hob's own limits: each one set replaces Settings › Web's, and a null one follows it. */
export const HobWebLimits = Schema.Struct({
  searchesPerTurn: Schema.NullOr(LimitCount),
  pagesPerTurn: Schema.NullOr(LimitCount),
  searchesPerDay: Schema.NullOr(LimitCount),
});
export type HobWebLimits = typeof HobWebLimits.Type;

export const NO_HOB_WEB_LIMITS: HobWebLimits = { searchesPerTurn: null, pagesPerTurn: null, searchesPerDay: null };

/** The limits that hold for a hob: its own where it set one, Settings › Web's for the rest. */
export const effectiveWebLimits = (settings: WebSettings, hob: HobWebLimits): WebLimits => ({
  searchesPerTurn: hob.searchesPerTurn ?? settings.limits.searchesPerTurn,
  pagesPerTurn: hob.pagesPerTurn ?? settings.limits.pagesPerTurn,
  searchesPerDay: hob.searchesPerDay ?? settings.limits.searchesPerDay,
});

/** The blocked site that covers `host`, or null: the site itself or a name under it. */
export const blockedSiteFor = (host: string, blocked: ReadonlyArray<string>): string | null => {
  const name = host.toLowerCase().replace(/\.$/, "");
  return blocked.find((site) => name === site || name.endsWith(`.${site}`)) ?? null;
};

/** The turn a record belongs to: a chat reply's (`reply:<id>`) or a session's Attempt (`attempt:<id>`). */
export const webTurnKey = (turn: { readonly messageId: MessageId | null; readonly attemptId: AttemptId | null }) =>
  turn.messageId !== null ? `reply:${turn.messageId}` : turn.attemptId !== null ? `attempt:${turn.attemptId}` : null;

export const WebRecordId = Schema.String.pipe(Schema.brand("WebRecordId"));
export type WebRecordId = typeof WebRecordId.Type;

/** Where a record was made: the hob, its chat and reply, and the Task and Attempt it worked on. */
const WebRecordPlace = {
  id: WebRecordId,
  agentId: AgentId,
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  taskId: Schema.NullOr(TaskId),
  attemptId: Schema.NullOr(AttemptId),
  /** The turn it belongs to, as `webTurnKey` names it; null when neither is known. */
  turn: Schema.NullOr(Schema.String),
  at: Schema.String,
};

/** One search result as the runtime reported it. */
export const WebSearchHit = Schema.Struct({ title: Schema.String, url: Schema.String });
export type WebSearchHit = typeof WebSearchHit.Type;

/**
 * One search a runtime ran (ADR 036), journaled as `WebSearched`. `resultCount` and `results` are
 * null when the runtime reported no structured results. `billing` is where the runtime said the turn
 * was billed, which says whether a search costs money (`webSearchBilledPerSearch`).
 */
export class WebSearchRecord extends Schema.Class<WebSearchRecord>("WebSearchRecord")({
  ...WebRecordPlace,
  runtime: RuntimeKind,
  query: Schema.String,
  resultCount: Schema.NullOr(Schema.Int),
  results: Schema.NullOr(Schema.Array(WebSearchHit)),
  billing: Schema.NullOr(Schema.String),
}) {}

/**
 * One page `web_fetch` read (ADR 036), journaled as `WebFetched`: the URL asked for, the one read
 * after redirects, the site's status, the bytes it sent, how many parts the page has and which was
 * read, and an estimate of the tokens the answer took (a token per four characters).
 */
export class WebFetchRecord extends Schema.Class<WebFetchRecord>("WebFetchRecord")({
  ...WebRecordPlace,
  url: Schema.String,
  finalUrl: Schema.String,
  status: Schema.Int,
  bytes: Schema.Int,
  parts: Schema.Int,
  part: Schema.Int,
  tokens: Schema.Int,
}) {}

/** The tokens an answer of `chars` characters takes, estimated as a token per four characters. */
export const estimatedTokens = (chars: number): number => Math.ceil(chars / 4);

/**
 * Whether a search on `billing` costs money per search: an API key or the Claude API is billed for
 * each search (`api-key (…)`, `api (…)`), a subscription and the fake runtime are not.
 */
export const webSearchBilledPerSearch = (billing: string | null): boolean =>
  billing !== null && (billing === "api-key" || billing.startsWith("api-key ") || billing.startsWith("api "));

/** What a set of web records adds up to. `estimatedCostUsd` is null when no search was billed per search. */
export const WebUsageTotals = Schema.Struct({
  searches: Schema.Int,
  pages: Schema.Int,
  /** Bytes the sites sent for the pages read. */
  bytes: Schema.Int,
  /** The estimated tokens of the pages' answers. */
  tokens: Schema.Int,
  /** Searches billed per search, which the estimated cost counts. */
  billedSearches: Schema.Int,
  estimatedCostUsd: Schema.NullOr(Schema.Number),
});
export type WebUsageTotals = typeof WebUsageTotals.Type;

/** Which records to count or list: every field set narrows them, and none counts every record. */
export const WebUsageFilter = Schema.Struct({
  agentId: Schema.optionalKey(AgentId),
  threadId: Schema.optionalKey(ThreadId),
  messageId: Schema.optionalKey(MessageId),
  taskId: Schema.optionalKey(TaskId),
  attemptId: Schema.optionalKey(AttemptId),
  questId: Schema.optionalKey(QuestId),
  /** Only records made at or after this time (ISO 8601). */
  since: Schema.optionalKey(Schema.String),
});
export type WebUsageFilter = typeof WebUsageFilter.Type;

/** The searches and pages that match a filter, newest first, with what they add up to. */
export const WebUsage = Schema.Struct({
  totals: WebUsageTotals,
  searches: Schema.Array(WebSearchRecord),
  pages: Schema.Array(WebFetchRecord),
});
export type WebUsage = typeof WebUsage.Type;

/** A hob's limits as Settings › Web shows them: its overrides and what holds once they apply. */
export const HobWebLimitsView = Schema.Struct({
  agentId: AgentId,
  overrides: HobWebLimits,
  effective: WebLimits,
});
export type HobWebLimitsView = typeof HobWebLimitsView.Type;
