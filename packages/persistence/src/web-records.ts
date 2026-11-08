import { WebRecords, type WebUsageCount } from "@hobbots/agents";
import {
  type AgentId,
  DEFAULT_WEB_SETTINGS,
  HobWebLimits,
  NO_HOB_WEB_LIMITS,
  RuntimeKind,
  WebFetchRecord,
  WebSearchRecord,
  WebSettings,
  type WebUsageFilter,
  webSearchBilledPerSearch,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { int, json, type Row } from "./task-rows.ts";

// What hobs searched and read on the web, and Settings › Web (migration 0090_web_usage, ADR 036). Each
// write commits with its journal event (ADR 013).

const decodeSearch = Schema.decodeUnknownEffect(WebSearchRecord);
const decodeFetch = Schema.decodeUnknownEffect(WebFetchRecord);
const decodeSettings = Schema.decodeUnknownEffect(WebSettings);
const decodeHobLimits = Schema.decodeUnknownEffect(HobWebLimits);
const isRuntime = Schema.is(RuntimeKind);

const searchOf = (row: Row) =>
  decodeSearch({
    id: row.id,
    agentId: row.agentId,
    threadId: row.threadId,
    messageId: row.messageId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    turn: row.turn,
    at: row.searchedAt,
    runtime: row.runtime,
    query: row.query,
    resultCount: int(row.resultCount),
    results: json(row.results),
    billing: row.billing,
  }).pipe(Effect.orDie);

const fetchOf = (row: Row) =>
  decodeFetch({
    id: row.id,
    agentId: row.agentId,
    threadId: row.threadId,
    messageId: row.messageId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    turn: row.turn,
    at: row.fetchedAt,
    url: row.url,
    finalUrl: row.finalUrl,
    status: int(row.status),
    bytes: int(row.bytes),
    parts: int(row.parts),
    part: int(row.part),
    tokens: int(row.tokens),
  }).pipe(Effect.orDie);

const place = (record: WebSearchRecord | WebFetchRecord) => ({
  id: record.id,
  agent_id: record.agentId,
  thread_id: record.threadId,
  message_id: record.messageId,
  task_id: record.taskId,
  attempt_id: record.attemptId,
  turn: record.turn,
});

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** The web's records and Settings › Web in the database, each change journaled. */
export const WebRecordsLive = Layer.effect(
  WebRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const entriesOf = <A>(committed: Effect.Effect<Option.Option<{ readonly entries: A }>>) =>
      Effect.map(committed, (done) => (Option.isSome(done) ? done.value.entries : ([] as unknown as A)));

    /** The records' filter as SQL on a table whose time column is `at`. */
    const where = (filter: WebUsageFilter, at: string) =>
      sql.and([
        ...(filter.agentId === undefined ? [] : [sql`agent_id = ${filter.agentId}`]),
        ...(filter.threadId === undefined ? [] : [sql`thread_id = ${filter.threadId}`]),
        ...(filter.messageId === undefined ? [] : [sql`message_id = ${filter.messageId}`]),
        ...(filter.taskId === undefined ? [] : [sql`task_id = ${filter.taskId}`]),
        ...(filter.attemptId === undefined ? [] : [sql`attempt_id = ${filter.attemptId}`]),
        // A Quest's records are those of every Task in its tree: the Tasks under the one that holds it.
        ...(filter.questId === undefined
          ? []
          : [
              sql`task_id IN (SELECT t.id FROM tasks t JOIN quests q ON q.task_id = t.root_id
                WHERE q.id = ${filter.questId})`,
            ]),
        ...(filter.since === undefined ? [] : [sql`${sql(at)} >= ${filter.since}`]),
      ]);

    /** What every record a filter matches adds up to, in one statement per table. */
    const totals = (filter: WebUsageFilter) =>
      Effect.gen(function* () {
        const billed = yield* sql<{
          readonly runtime: string;
          readonly billing: string | null;
          readonly count: unknown;
        }>`
          SELECT runtime, billing, COUNT(*) AS count FROM web_searches WHERE ${where(filter, "searched_at")}
          GROUP BY runtime, billing`;
        const [pages] = yield* sql<{ readonly count: unknown; readonly bytes: unknown; readonly tokens: unknown }>`
          SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(tokens), 0) AS tokens
          FROM web_fetches WHERE ${where(filter, "fetched_at")}`;
        const perRuntime = new Map<RuntimeKind, number>();
        for (const row of billed) {
          if (!webSearchBilledPerSearch(row.billing) || !isRuntime(row.runtime)) continue;
          perRuntime.set(row.runtime, (perRuntime.get(row.runtime) ?? 0) + Number(row.count));
        }
        return {
          searches: billed.reduce((sum, row) => sum + Number(row.count), 0),
          pages: Number(pages?.count ?? 0),
          bytes: Number(pages?.bytes ?? 0),
          tokens: Number(pages?.tokens ?? 0),
          billed: [...perRuntime].map(([runtime, count]) => ({ runtime, count })),
        } satisfies WebUsageCount;
      });

    const settings = Effect.gen(function* () {
      const [row] = yield* sql<Row>`SELECT * FROM web_settings WHERE id = 1`;
      if (row === undefined) return DEFAULT_WEB_SETTINGS;
      return yield* decodeSettings({
        limits: {
          searchesPerTurn: int(row.searchesPerTurn),
          pagesPerTurn: int(row.pagesPerTurn),
          searchesPerDay: int(row.searchesPerDay),
        },
        blockedSites: json(row.blockedSites),
      }).pipe(
        // Settings a later Hobbots wrote that this one cannot read hold as the defaults.
        Effect.orElseSucceed(() => DEFAULT_WEB_SETTINGS),
      );
    });

    const die = <A>(effect: Effect.Effect<A, SqlError.SqlError>) => Effect.orDie(effect);

    return WebRecords.of({
      recordSearch: (search) =>
        entriesOf(
          journaled(1, () =>
            Effect.gen(function* () {
              yield* sql`INSERT INTO web_searches ${sql.insert({
                ...place(search),
                runtime: search.runtime,
                query: search.query,
                result_count: search.resultCount,
                results: search.results === null ? null : JSON.stringify(search.results),
                billing: search.billing,
                searched_at: search.at,
              })}`;
              return { value: search, events: [{ _tag: "WebSearched" as const, search }] };
            }),
          ),
        ),
      recordFetch: (fetch) =>
        entriesOf(
          journaled(1, () =>
            Effect.gen(function* () {
              yield* sql`INSERT INTO web_fetches ${sql.insert({
                ...place(fetch),
                url: fetch.url,
                final_url: fetch.finalUrl,
                status: fetch.status,
                bytes: fetch.bytes,
                parts: fetch.parts,
                part: fetch.part,
                tokens: fetch.tokens,
                fetched_at: fetch.at,
              })}`;
              return { value: fetch, events: [{ _tag: "WebFetched" as const, fetch }] };
            }),
          ),
        ),
      // The totals and the newest records are read in one transaction, so they agree.
      usage: (filter, limit) =>
        die(
          Effect.gen(function* () {
            const count = yield* totals(filter);
            const searches = yield* sql<Row>`SELECT * FROM web_searches WHERE ${where(filter, "searched_at")}
              ORDER BY searched_at DESC, id DESC LIMIT ${limit}`.pipe(Effect.flatMap(Effect.forEach(searchOf)));
            const pages = yield* sql<Row>`SELECT * FROM web_fetches WHERE ${where(filter, "fetched_at")}
              ORDER BY fetched_at DESC, id DESC LIMIT ${limit}`.pipe(Effect.flatMap(Effect.forEach(fetchOf)));
            return { count, searches, pages };
          }).pipe(sql.withTransaction),
        ),
      searchesSince: (agentId, since) =>
        die(
          sql<{ readonly count: unknown }>`SELECT COUNT(*) AS count FROM web_searches
            WHERE agent_id = ${agentId} AND searched_at >= ${since}`.pipe(
            Effect.map(([row]) => Number(row?.count ?? 0)),
          ),
        ),
      holdSearch: (work, reason) =>
        die(
          Effect.gen(function* () {
            const at = yield* nowIso;
            yield* sql`INSERT INTO web_search_holds ${sql.insert({ work, reason, held_at: at })}
              ON CONFLICT (work) DO UPDATE SET reason = ${reason}, held_at = ${at}`;
          }),
        ),
      takeSearchHold: (work) =>
        die(
          Effect.gen(function* () {
            const [row] = yield* sql<{ readonly reason: string }>`DELETE FROM web_search_holds WHERE work = ${work}
              RETURNING reason`;
            return row?.reason ?? null;
          }),
        ),
      settings: die(settings),
      setSettings: (next) =>
        entriesOf(
          journaled(1, () =>
            Effect.gen(function* () {
              const columns = {
                searches_per_turn: next.limits.searchesPerTurn,
                pages_per_turn: next.limits.pagesPerTurn,
                searches_per_day: next.limits.searchesPerDay,
                blocked_sites: JSON.stringify(next.blockedSites),
                updated_at: yield* nowIso,
              };
              yield* sql`INSERT INTO web_settings ${sql.insert({ id: 1, ...columns })}
                ON CONFLICT (id) DO UPDATE SET ${sql.update(columns)}`;
              return { value: next, events: [{ _tag: "WebSettingsChanged" as const, settings: next }] };
            }),
          ),
        ),
      hobLimits: (agentId: AgentId) =>
        die(
          Effect.gen(function* () {
            const [row] = yield* sql<Row>`SELECT * FROM agent_web_limits WHERE agent_id = ${agentId}`;
            if (row === undefined) return NO_HOB_WEB_LIMITS;
            return yield* decodeHobLimits({
              searchesPerTurn: int(row.searchesPerTurn),
              pagesPerTurn: int(row.pagesPerTurn),
              searchesPerDay: int(row.searchesPerDay),
            }).pipe(Effect.orElseSucceed(() => NO_HOB_WEB_LIMITS));
          }),
        ),
      setHobLimits: (agentId, limits) =>
        entriesOf(
          journaled(1, () =>
            Effect.gen(function* () {
              const columns = {
                searches_per_turn: limits.searchesPerTurn,
                pages_per_turn: limits.pagesPerTurn,
                searches_per_day: limits.searchesPerDay,
                updated_at: yield* nowIso,
              };
              yield* sql`INSERT INTO agent_web_limits ${sql.insert({ agent_id: agentId, ...columns })}
                ON CONFLICT (agent_id) DO UPDATE SET ${sql.update(columns)}`;
              return { value: limits, events: [{ _tag: "HobWebLimitsChanged" as const, agentId, limits }] };
            }),
          ),
        ),
    });
  }),
);
