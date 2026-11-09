import {
  type AgentId,
  type AttemptId,
  BlockedSite,
  DEFAULT_WEB_SETTINGS,
  type EventEnvelope,
  effectiveWebLimits,
  type HobWebLimits,
  type MessageId,
  NO_HOB_WEB_LIMITS,
  type RuntimeKind,
  type TaskId,
  type ThreadId,
  type WebFetchRecord,
  type WebLimits,
  WebRecordId,
  WebSearchRecord,
  type WebSettings,
  type WebTurnCount,
  type WebUsageFilter,
  webSearchBilledPerSearch,
  webTurnKey,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { announcer, EventPublisher } from "./ports.ts";
import type { RuntimeEvent } from "./runtime.ts";

/**
 * What hobs search and read on the web, and the limits on it (ADR 036, Usage and limits). The hub
 * records every search a runtime reports and every page `web_fetch` reads, and enforces the limits
 * of Settings › Web with each hob's overrides. No adapter knows a limit: one whose runtime can refuse
 * a search asks the hub through `PromptRequest.checkWebSearch`, and a runtime that cannot, as Codex's
 * hosted search, gets search turned off on its next turn instead.
 */

/** What a set of records adds up to before prices: the server prices `billed` with its own table. */
export interface WebUsageCount {
  readonly searches: number;
  readonly pages: number;
  readonly bytes: number;
  readonly tokens: number;
  /** Searches billed per search, per runtime. */
  readonly billed: ReadonlyArray<{ readonly runtime: RuntimeKind; readonly count: number }>;
}

/** The records a filter matches, newest first, and what all of them add up to. */
export interface WebUsageRead {
  readonly count: WebUsageCount;
  readonly searches: ReadonlyArray<WebSearchRecord>;
  readonly pages: ReadonlyArray<WebFetchRecord>;
}

/** What every hob searched and read since a time: the totals, each hob's counts and each turn's. */
export interface WebUsageSince {
  readonly count: WebUsageCount;
  readonly hobs: ReadonlyArray<{ readonly agentId: AgentId; readonly searches: number; readonly pages: number }>;
  readonly turns: ReadonlyArray<WebTurnCount>;
}

/**
 * The web's records and settings, each change journaled in its transaction (`WebSearched`,
 * `WebFetched`, `WebSettingsChanged`, `HobWebLimitsChanged`), which answers the entries it committed.
 */
export class WebRecords extends Context.Service<
  WebRecords,
  {
    readonly recordSearch: (search: WebSearchRecord) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
    readonly recordFetch: (fetch: WebFetchRecord) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
    /** The records `filter` matches, at most `limit` of each kind, and their totals over all of them. */
    readonly usage: (filter: WebUsageFilter, limit: number) => Effect.Effect<WebUsageRead>;
    /** Every record at or after `since`, counted per hob and per turn, for Usage. */
    readonly usageSince: (since: string) => Effect.Effect<WebUsageSince>;
    /** How many searches a hob ran at or after `since`. */
    readonly searchesSince: (agentId: AgentId, since: string) => Effect.Effect<number>;
    /**
     * Admits one more search for a hob under its daily `limit`, counting the searches it ran at or
     * after `since` and those its turns admitted and have not recorded yet, in every turn of the hub.
     */
    readonly admitSearch: (agentId: AgentId, since: string, limit: number) => Effect.Effect<boolean>;
    /** Gives back a search `admitSearch` admitted, once the turn recorded it or ended without it. */
    readonly releaseSearch: (agentId: AgentId) => Effect.Effect<void>;
    /** Keeps search off for the next turn of `work`, saying why (Codex's soft per-turn limit). */
    readonly holdSearch: (work: string, reason: string) => Effect.Effect<void>;
    /** Takes the hold on `work`'s search, if any: the reason it holds, once. */
    readonly takeSearchHold: (work: string) => Effect.Effect<string | null>;
    readonly settings: Effect.Effect<WebSettings>;
    readonly setSettings: (settings: WebSettings) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
    readonly hobLimits: (agentId: AgentId) => Effect.Effect<HobWebLimits>;
    readonly setHobLimits: (agentId: AgentId, limits: HobWebLimits) => Effect.Effect<ReadonlyArray<EventEnvelope>>;
  }
>()("@hobbots/agents/WebRecords") {
  /** Records in the hub's memory, for tests and hubs without a database. */
  static readonly memory = Layer.sync(WebRecords, () => {
    const searches: Array<WebSearchRecord> = [];
    const pages: Array<WebFetchRecord> = [];
    const holds = new Map<string, string>();
    const hobs = new Map<AgentId, HobWebLimits>();
    let settings: WebSettings = DEFAULT_WEB_SETTINGS;
    const matches = (filter: WebUsageFilter) => (record: WebSearchRecord | WebFetchRecord) =>
      (filter.agentId === undefined || record.agentId === filter.agentId) &&
      (filter.threadId === undefined || record.threadId === filter.threadId) &&
      (filter.messageId === undefined || record.messageId === filter.messageId) &&
      (filter.taskId === undefined || record.taskId === filter.taskId) &&
      (filter.attemptId === undefined || record.attemptId === filter.attemptId) &&
      (filter.since === undefined || record.at >= filter.since);
    const newest = <A extends { readonly at: string }>(a: A, b: A) => b.at.localeCompare(a.at);
    const searchesSince = (agentId: AgentId, since: string) =>
      Effect.sync(() => searches.filter((s) => s.agentId === agentId && s.at >= since).length);
    return WebRecords.of({
      recordSearch: (search) => Effect.sync(() => (searches.push(search), NONE)),
      recordFetch: (fetch) => Effect.sync(() => (pages.push(fetch), NONE)),
      usage: (filter, limit) =>
        Effect.sync(() => {
          const found = searches.filter(matches(filter)).sort(newest);
          const read = pages.filter(matches(filter)).sort(newest);
          return {
            count: countOf(found, read),
            searches: found.slice(0, limit),
            pages: read.slice(0, limit),
          };
        }),
      usageSince: (since) =>
        Effect.sync(() => {
          const found = searches.filter((search) => search.at >= since);
          const read = pages.filter((page) => page.at >= since);
          return { count: countOf(found, read), ...countsByHobAndTurn(found, read) };
        }),
      searchesSince,
      ...makeSearchAllowance(searchesSince),
      holdSearch: (work, reason) => Effect.sync(() => void holds.set(work, reason)),
      takeSearchHold: (work) =>
        Effect.sync(() => {
          const reason = holds.get(work) ?? null;
          holds.delete(work);
          return reason;
        }),
      settings: Effect.sync(() => settings),
      setSettings: (next) =>
        Effect.sync(() => {
          settings = next;
          return NONE;
        }),
      hobLimits: (agentId) => Effect.sync(() => hobs.get(agentId) ?? NO_HOB_WEB_LIMITS),
      setHobLimits: (agentId, limits) => Effect.sync(() => (hobs.set(agentId, limits), NONE)),
    });
  });
}

/** Records counted per hob and per turn, as `usageSince` answers them. */
export const countsByHobAndTurn = (
  searches: ReadonlyArray<WebSearchRecord>,
  pages: ReadonlyArray<WebFetchRecord>,
): Pick<WebUsageSince, "hobs" | "turns"> => {
  const hobs = new Map<AgentId, { agentId: AgentId; searches: number; pages: number }>();
  const turns = new Map<string, { -readonly [K in keyof WebTurnCount]: WebTurnCount[K] }>();
  const add = (record: WebSearchRecord | WebFetchRecord, kind: "searches" | "pages") => {
    const hob = hobs.get(record.agentId) ?? { agentId: record.agentId, searches: 0, pages: 0 };
    hob[kind] += 1;
    hobs.set(record.agentId, hob);
    if (record.turn === null) return;
    const key = `${record.agentId} ${record.turn}`;
    const turn = turns.get(key) ?? {
      turn: record.turn,
      agentId: record.agentId,
      threadId: record.threadId,
      messageId: record.messageId,
      taskId: record.taskId,
      at: record.at,
      searches: 0,
      pages: 0,
    };
    turn[kind] += 1;
    if (record.at > turn.at) turn.at = record.at;
    turns.set(key, turn);
  };
  for (const search of searches) add(search, "searches");
  for (const page of pages) add(page, "pages");
  return { hobs: [...hobs.values()], turns: [...turns.values()] };
};

/**
 * The daily allowance every turn of a hub shares (ADR 036, Usage and limits): a search is admitted
 * only while the hob's recorded searches and those its turns admitted and have not recorded yet stay
 * under the limit, so two turns of one hob cannot each take the last search of its day. One permit
 * orders every admission and release, so a search recorded and released while another turn is being
 * admitted is counted once, never missed.
 */
export const makeSearchAllowance = (searchesSince: (agentId: AgentId, since: string) => Effect.Effect<number>) => {
  const lock = Semaphore.makeUnsafe(1);
  const open = new Map<AgentId, number>();
  return {
    admitSearch: (agentId: AgentId, since: string, limit: number) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const ran = yield* searchesSince(agentId, since);
          const admitted = open.get(agentId) ?? 0;
          if (ran + admitted >= limit) return false;
          open.set(agentId, admitted + 1);
          return true;
        }),
      ),
    releaseSearch: (agentId: AgentId) =>
      Semaphore.withPermit(
        lock,
        Effect.sync(() => {
          const left = (open.get(agentId) ?? 0) - 1;
          if (left > 0) open.set(agentId, left);
          else open.delete(agentId);
        }),
      ),
  };
};

/**
 * A blocked-sites entry as it is kept: lowercase, without a scheme, path, port or leading `*.`, and
 * without the dot a fully qualified name ends with. Null for anything that names no host.
 */
export const blockedSiteOf = (raw: string): string | null => {
  let text = raw.trim().toLowerCase();
  if (text === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `http://${text.replace(/^\*\./, "")}`;
  try {
    const host = new URL(text).hostname.replace(/\.$/, "");
    return isBlockedSite(host) ? host : null;
  } catch {
    return null;
  }
};

const isBlockedSite = Schema.is(BlockedSite);

/** What a write in memory committed to no journal. */
const NONE: ReadonlyArray<EventEnvelope> = [];

/** Announces what a write committed, when the hub has a publisher; a failed announcement is only logged. */
export const webAnnouncer = Effect.map(Effect.serviceOption(EventPublisher), (publisher) =>
  announcer(publisher, "a web record"),
);

/** What records add up to, as `WebRecords.usage` counts them. */
export const countOf = (
  searches: ReadonlyArray<WebSearchRecord>,
  pages: ReadonlyArray<WebFetchRecord>,
): WebUsageCount => {
  const billed = new Map<RuntimeKind, number>();
  for (const search of searches) {
    if (webSearchBilledPerSearch(search.billing)) billed.set(search.runtime, (billed.get(search.runtime) ?? 0) + 1);
  }
  return {
    searches: searches.length,
    pages: pages.length,
    bytes: pages.reduce((sum, page) => sum + page.bytes, 0),
    tokens: pages.reduce((sum, page) => sum + page.tokens, 0),
    billed: [...billed].map(([runtime, count]) => ({ runtime, count })),
  };
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** The limits that hold for a hob now, read from Settings › Web and its overrides. */
export const webLimitsOf = (agentId: AgentId) =>
  Effect.gen(function* () {
    const records = yield* Effect.serviceOption(WebRecords);
    if (Option.isNone(records)) return { limits: DEFAULT_WEB_SETTINGS.limits, blockedSites: [] as const };
    const settings = yield* records.value.settings;
    const hob = yield* records.value.hobLimits(agentId);
    return { limits: effectiveWebLimits(settings, hob), blockedSites: settings.blockedSites };
  });

/** The words a limit is refused or turned off with, which name the limit and how to change it. */
export const webLimitReason = {
  searchesPerTurn: (limits: WebLimits) =>
    `This turn reached its limit of ${limits.searchesPerTurn} web ${limits.searchesPerTurn === 1 ? "search" : "searches"}, set in Settings › Web.`,
  searchesPerDay: (limits: WebLimits) =>
    `This hob reached its limit of ${limits.searchesPerDay} web ${limits.searchesPerDay === 1 ? "search" : "searches"} a day, set in Settings › Web.`,
  pagesPerTurn: (limits: WebLimits) =>
    `This turn reached its limit of ${limits.pagesPerTurn} web ${limits.pagesPerTurn === 1 ? "page" : "pages"} read with web_fetch, set in Settings › Web.`,
  blockedSite: (site: string) => `${site} is on the blocked sites in Settings › Web, so web_fetch does not read it.`,
};

/** Where a turn runs: its hob, chat and reply, the Task and Attempt it works on once known, and its runtime. */
export interface WebTurnPlace {
  readonly agentId: AgentId;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
  readonly runtime: RuntimeKind;
  /** The session's work, as `webWorkOf` names it, which a hold on its search belongs to. */
  readonly work: string | null;
  readonly taskId: Effect.Effect<TaskId | null>;
  readonly attemptId: Effect.Effect<AttemptId | null>;
}

/** A turn's web search, as the hub settles, limits and records it. */
export interface WebSearchTurn {
  /** Whether the limits leave search on for the turn; the policy decides too (`turnWebSearch`). */
  readonly on: boolean;
  /** What the hob is told when a limit turned search off for the turn, or null. */
  readonly note: string | null;
  /** `PromptRequest.checkWebSearch`: refuses a search past a limit, with the words that name it. */
  readonly check: (query: string) => Effect.Effect<string | null>;
  /** Reads the turn's events: where it is billed, and each search, which it records. */
  readonly see: (event: RuntimeEvent) => Effect.Effect<void>;
  /** Ends the turn: a turn over its search limit, as on Codex, holds search off for the session's next. */
  readonly end: Effect.Effect<void>;
}

/**
 * What a turn's request takes from its web search: whether it may search, once the policy allows it
 * and the limits leave it on, the check for each search, and the note for its briefing.
 */
export const webSearchRequest = (allowed: boolean, web: WebSearchTurn) => ({
  webSearch: allowed && web.on,
  checkWebSearch: web.check,
  note: allowed ? web.note : null,
});

const UNLIMITED: WebSearchTurn = {
  on: true,
  note: null,
  check: () => Effect.succeed(null),
  see: () => Effect.void,
  end: Effect.void,
};

/**
 * Settles a turn's web search against the hob's limits as the turn starts: off when the hob reached
 * its daily limit or a hold from the session's last turn applies, with a note that says why. Then
 * refuses each search past a limit where the runtime asks, and records each search it reports.
 */
export const webSearchTurn = (place: WebTurnPlace): Effect.Effect<WebSearchTurn> =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(WebRecords);
    if (Option.isNone(found)) return UNLIMITED;
    const records = found.value;
    const announce = yield* webAnnouncer;
    const { limits } = yield* webLimitsOf(place.agentId);
    const now = yield* DateTime.now;
    const today = yield* records.searchesSince(place.agentId, DateTime.formatIso(DateTime.subtract(now, { days: 1 })));
    const held = place.work === null ? null : yield* records.takeSearchHold(place.work);
    const off =
      today >= limits.searchesPerDay
        ? webLimitReason.searchesPerDay(limits)
        : limits.searchesPerTurn === 0
          ? webLimitReason.searchesPerTurn(limits)
          : held;
    let allowed = 0;
    // Searches this turn was admitted to the hob's daily allowance for and has not recorded yet.
    let admitted = 0;
    let searched = 0;
    let billing: string | null = null;
    const release = Effect.suspend(() => {
      if (admitted === 0) return Effect.void;
      admitted -= 1;
      return records.releaseSearch(place.agentId);
    });
    return {
      on: off === null,
      note: off === null ? null : `Web search is off for this turn. ${off}`,
      check: () =>
        Effect.gen(function* () {
          if (allowed >= limits.searchesPerTurn) return webLimitReason.searchesPerTurn(limits);
          // Taken before the daily check, so concurrent calls in one turn cannot pass the turn's limit.
          allowed += 1;
          const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }));
          if (!(yield* records.admitSearch(place.agentId, since, limits.searchesPerDay))) {
            allowed -= 1;
            return webLimitReason.searchesPerDay(limits);
          }
          admitted += 1;
          return null;
        }),
      see: (event) =>
        Effect.gen(function* () {
          if (event._tag === "SessionStarted") billing = event.billing;
          if (event._tag !== "WebSearched") return;
          searched += 1;
          const messageId = place.messageId;
          const attemptId = yield* place.attemptId;
          const entries = yield* records.recordSearch(
            new WebSearchRecord({
              id: WebRecordId.make(crypto.randomUUID()),
              agentId: place.agentId,
              threadId: place.threadId,
              messageId,
              taskId: yield* place.taskId,
              attemptId,
              turn: webTurnKey({ messageId, attemptId }),
              at: yield* nowIso,
              runtime: place.runtime,
              query: event.query,
              resultCount: event.results?.length ?? null,
              results: event.results?.map((hit) => ({ title: hit.title, url: hit.url })) ?? null,
              billing,
            }),
          );
          yield* announce(entries);
          // Recorded first, so the allowance never counts the search less than once.
          yield* release;
        }),
      end: Effect.suspend(() =>
        Effect.andThen(
          // An admitted search the runtime never reported gives its place back.
          Effect.whileLoop({ while: () => admitted > 0, body: () => release, step: () => undefined }),
          place.work !== null && searched > limits.searchesPerTurn
            ? records.holdSearch(
                place.work,
                `The last turn ran ${searched} web searches, past its limit of ${limits.searchesPerTurn} set in Settings › Web.`,
              )
            : Effect.void,
        ),
      ),
    };
  });
