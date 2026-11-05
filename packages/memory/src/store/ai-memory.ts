import { guardMemoryStore, MemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import {
  type MemoryActor,
  MemoryConflict,
  type MemoryExpected,
  type MemoryHit,
  type MemoryPage,
  type MemoryPageSummary,
  MemoryPath,
  type MemoryScope,
  MemoryUnavailable,
  MemoryVersion,
  memoryTitleOf,
  searchTerms,
} from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import {
  type EngineCaller,
  type EngineClient,
  type EngineRefused,
  makeEngineClient,
  noSuchProject,
  ROOT,
} from "./client.ts";
import { authorOfUsername, type EngineProject, engineActorOf, engineProjectOf } from "./scopes.ts";

/**
 * `MemoryStore` on the bundled ai-memory (ADR 028). A hob's searches and writes go over `/mcp` with
 * the proxy bearer, asserting the hob, so ai-memory stamps the hob as each page's author; your edits
 * and every read go with the root bearer. Scopes map to ai-memory projects (`engineProjectOf`); a
 * scope with no project yet is empty. Which scopes a call may touch is decided by `guardMemoryStore`
 * before any request is made.
 */

// What ai-memory answers, in the fields read.
const PageJson = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  title: Schema.String,
  pinned: Schema.Boolean,
  updated_at: Schema.String,
  body_markdown: Schema.String,
  frontmatter: Schema.Struct({
    tags: Schema.optionalKey(Schema.Array(Schema.String)),
    last_modified_by: Schema.optionalKey(Schema.Struct({ username: Schema.optionalKey(Schema.String) })),
  }),
});
const SummaryJson = Schema.Struct({ path: Schema.String, title: Schema.String, updated_at: Schema.String });
const ChangesJson = Schema.Struct({ pages: Schema.Array(SummaryJson), next_cursor: Schema.NullOr(Schema.String) });
const HistoryJson = Schema.Struct({
  total: Schema.Number,
  versions: Schema.Array(Schema.Struct({ id: Schema.String, is_latest: Schema.Boolean, created_at: Schema.String })),
});
const HitsJson = Schema.Struct({
  hits: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      title: Schema.String,
      snippet: Schema.optionalKey(Schema.String),
      rank: Schema.Number,
      pinned: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const WrittenJson = Schema.Struct({ page_id: Schema.String });
const DeletedJson = Schema.Struct({
  deleted: Schema.Boolean,
  pre_checkpoint: Schema.NullOr(Schema.String),
  checkpoint: Schema.NullOr(Schema.String),
});
const PreconditionJson = Schema.Struct({
  reason: Schema.Literal("precondition_failed"),
  current_page_id: Schema.NullOr(Schema.String),
});

/** The most pages one request reads back; ai-memory clamps its limits to 100. */
const PAGE_LIMIT = 100;
/** The most versions one history request reads back, ai-memory's own cap. */
const VERSION_LIMIT = 200;
/**
 * A search no page can match: `memory_query` with `pin_first` then answers only the scope's pinned
 * pages, which is how ai-memory lists them, the newest first and at most `PIN_FIRST_MAX` of them.
 */
const PINNED_ONLY = '"hobbots0pinned0pages0only0x9q"';
const PIN_FIRST_MAX = 10;
/** How many pin queries run at once. */
const READ_CONCURRENCY = 8;
/** A forgotten page comes back from the wiki's Git revision before its delete, marked so. */
const REVISION = "rev:";

const callerOf = (actor: MemoryActor): EngineCaller =>
  actor._tag === "You" ? ROOT : { as: "hob", name: engineActorOf(actor.agentId) };

/** The scope's place in a tool call: `scope: "global"` for everyone's, a workspace and project otherwise. */
const target = (scope: MemoryScope, where: EngineProject): Record<string, unknown> =>
  scope._tag === "Everyone" ? { scope: "global" } : { workspace: where.workspace, project: where.project };

const pagesRoute = (where: EngineProject) =>
  `workspaces/${encodeURIComponent(where.workspace)}/projects/${encodeURIComponent(where.project)}`;

/** A search's words as an FTS5 query that matches them as words or their starts, with nothing to escape. */
const ftsQuery = (query: string) =>
  searchTerms(query)
    .map((term) => `"${term}"*`)
    .join(" ");

const plain = (snippet: string | undefined) => (snippet ?? "").replace(/<\/?mark>/g, "");

/** An empty scope: ai-memory creates a scope's project on its first write. */
const orEmpty =
  <A>(empty: A) =>
  <B, E, R>(effect: Effect.Effect<B, E | EngineRefused, R>): Effect.Effect<A | B, E | EngineRefused, R> =>
    effect.pipe(
      Effect.catchTag("EngineRefused", (refused) =>
        noSuchProject(refused as EngineRefused) ? Effect.succeed(empty) : Effect.fail(refused),
      ),
    ) as Effect.Effect<A | B, E | EngineRefused, R>;

/**
 * A refusal left over is a route or argument Hobbots got wrong, or an engine that changed: callers see
 * an outage, never wrong data, and the hub keeps running.
 */
const refusalIsOutage = <A, E, R>(
  effect: Effect.Effect<A, E | EngineRefused, R>,
): Effect.Effect<A, Exclude<E, EngineRefused> | MemoryUnavailable, R> =>
  effect.pipe(
    Effect.catchTag("EngineRefused", (refused) =>
      Effect.fail(
        new MemoryUnavailable({
          message: `Memory refused a request (${(refused as EngineRefused).status}): ${(refused as EngineRefused).message}`,
        }),
      ),
    ),
  ) as Effect.Effect<A, Exclude<E, EngineRefused> | MemoryUnavailable, R>;

const makeStore = (client: EngineClient): MemoryStoreShape => {
  const pageOf = (scope: MemoryScope, path: MemoryPath) =>
    Effect.gen(function* () {
      const where = engineProjectOf(scope);
      const json = yield* client.get(`${pagesRoute(where)}/pages/${path}`, PageJson);
      const page: MemoryPage = {
        scope,
        path,
        markdown: json.body_markdown,
        tags: json.frontmatter.tags ?? [],
        pinned: json.pinned,
        version: MemoryVersion.make(json.id),
        author: authorOfUsername(json.frontmatter.last_modified_by?.username),
        updatedAt: json.updated_at,
      };
      return page as MemoryPage | null;
    }).pipe(orEmpty(null));

  /** The scope's pinned pages under `prefix`, the newest first and at most `PIN_FIRST_MAX` of them. */
  const pinsUnder = (where: EngineProject, prefix: string) =>
    client
      .tool(
        ROOT,
        "memory_query",
        {
          ...where,
          query: PINNED_ONLY,
          pin_first: true,
          limit: PAGE_LIMIT,
          ...(prefix === "" ? {} : { path_prefix: prefix }),
        },
        HitsJson,
      )
      .pipe(Effect.map((json) => json.hits.filter((hit) => hit.pinned === true).map((hit) => hit.path)));

  /**
   * Every pinned page of the scope, from pin metadata alone. ai-memory answers at most ten pins a
   * query, so a prefix that fills the answer is split by the next character of the scope's paths
   * until each part answers in full. No page body is read, but for a path that is itself a prefix
   * of a full answer.
   */
  const pinnedPaths = (scope: MemoryScope): Effect.Effect<ReadonlySet<string>, MemoryUnavailable | EngineRefused> =>
    Effect.gen(function* () {
      const where = engineProjectOf(scope);
      const first = yield* pinsUnder(where, "");
      if (first.length < PIN_FIRST_MAX) return new Set(first);
      const paths = (yield* client.get(`${pagesRoute(where)}/pages`, Schema.Array(SummaryJson))).map(
        (each) => each.path,
      );
      const pinned = new Set<string>();
      const walk = (
        prefix: string,
        found: ReadonlyArray<string>,
      ): Effect.Effect<void, MemoryUnavailable | EngineRefused> =>
        Effect.gen(function* () {
          if (found.length < PIN_FIRST_MAX) {
            for (const path of found) pinned.add(path);
            return;
          }
          if (paths.includes(prefix) && (yield* pageOf(scope, MemoryPath.make(prefix)))?.pinned === true) {
            pinned.add(prefix);
          }
          const next = new Set(
            paths
              .filter((path) => path.length > prefix.length && path.startsWith(prefix))
              .map((path) => path.slice(0, prefix.length + 1)),
          );
          yield* Effect.forEach(next, (child) => Effect.flatMap(pinsUnder(where, child), (hits) => walk(child, hits)), {
            concurrency: READ_CONCURRENCY,
            discard: true,
          });
        });
      yield* walk("", first);
      return pinned;
    }).pipe(orEmpty(new Set<string>() as ReadonlySet<string>));

  const summaryOf =
    (scope: MemoryScope, pinned: ReadonlySet<string>) =>
    (json: typeof SummaryJson.Type): MemoryPageSummary => ({
      scope,
      path: MemoryPath.make(json.path),
      title: json.title,
      pinned: pinned.has(json.path),
      updatedAt: json.updated_at,
    });

  const conflictOf =
    (path: MemoryPath) =>
    (refused: EngineRefused): Effect.Effect<never, MemoryConflict | EngineRefused> => {
      const found = Schema.decodeUnknownOption(PreconditionJson)(refused.data);
      if (found._tag === "None") return Effect.fail(refused);
      const current = found.value.current_page_id;
      return Effect.fail(new MemoryConflict({ path, current: current === null ? null : MemoryVersion.make(current) }));
    };

  const currentConflict = (scope: MemoryScope, path: MemoryPath) =>
    Effect.flatMap(pageOf(scope, path), (page) =>
      Effect.fail(new MemoryConflict({ path, current: page?.version ?? null })),
    );

  const searchOne = (actor: MemoryActor, scope: MemoryScope, query: string, limit: number) =>
    client.tool(callerOf(actor), "memory_query", { ...engineProjectOf(scope), query, limit }, HitsJson).pipe(
      Effect.map((json) =>
        json.hits.map((hit) => ({
          rank: hit.rank,
          hit: { scope, path: MemoryPath.make(hit.path), title: hit.title, snippet: plain(hit.snippet) } as MemoryHit,
        })),
      ),
      orEmpty([] as Array<{ readonly rank: number; readonly hit: MemoryHit }>),
    );

  const changesFrom = (
    scope: MemoryScope,
    since: string,
    pinned: ReadonlySet<string>,
  ): Effect.Effect<Array<MemoryPageSummary>, MemoryUnavailable | EngineRefused> =>
    Effect.gen(function* () {
      const route = `${pagesRoute(engineProjectOf(scope))}/recent`;
      const found: Array<MemoryPageSummary> = [];
      let cursor: string | null = null;
      do {
        const params: Record<string, string> =
          cursor === null ? { updated_since: since, limit: `${PAGE_LIMIT}` } : { cursor, limit: `${PAGE_LIMIT}` };
        const page: typeof ChangesJson.Type = yield* client.get(route, ChangesJson, params);
        found.push(...page.pages.map(summaryOf(scope, pinned)));
        cursor = page.next_cursor;
      } while (cursor !== null);
      return found;
    }).pipe(orEmpty([] as Array<MemoryPageSummary>));

  const store: MemoryStoreShape = {
    search: (actor, scopes, query, limit) => {
      const fts = ftsQuery(query);
      if (fts === "") return Effect.succeed([]);
      return Effect.forEach(scopes, (scope) => searchOne(actor, scope, fts, limit), { concurrency: "unbounded" }).pipe(
        // FTS5 ranks lower for a better match.
        Effect.map((found) =>
          found
            .flat()
            .sort((a, b) => a.rank - b.rank)
            .slice(0, limit)
            .map((each) => each.hit),
        ),
        refusalIsOutage,
      );
    },
    page: (_actor, scope, path) => refusalIsOutage(pageOf(scope, path)),
    list: (_actor, scope, limit) =>
      Effect.gen(function* () {
        const where = engineProjectOf(scope);
        const pinned = yield* pinnedPaths(scope);
        const recent = yield* client
          .get(`${pagesRoute(where)}/recent`, Schema.Array(SummaryJson), {
            limit: `${Math.min(limit, PAGE_LIMIT)}`,
          })
          .pipe(orEmpty([] as ReadonlyArray<typeof SummaryJson.Type>));
        const summaries = recent.map(summaryOf(scope, pinned));
        // A pinned page that is not among the newest is read on its own; there are few of them.
        const listed = new Set(summaries.map((each) => each.path as string));
        const missing = [...pinned].filter((path) => !listed.has(path));
        const older = yield* Effect.forEach(missing, (path) => pageOf(scope, MemoryPath.make(path)));
        for (const page of older) {
          if (page === null) continue;
          summaries.push({
            scope,
            path: page.path,
            title: memoryTitleOf(page.path, page.markdown),
            pinned: true,
            updatedAt: page.updatedAt,
          });
        }
        return summaries
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit);
      }).pipe(refusalIsOutage),
    changes: (_actor, scope, since) =>
      Effect.flatMap(pinnedPaths(scope), (pinned) => changesFrom(scope, since, pinned)).pipe(refusalIsOutage),
    history: (_actor, scope, path) =>
      Effect.gen(function* () {
        const where = engineProjectOf(scope);
        const versions: Array<(typeof HistoryJson.Type)["versions"][number]> = [];
        let total = 0;
        do {
          const params = { limit: `${VERSION_LIMIT}`, offset: `${versions.length}` };
          const json: typeof HistoryJson.Type = yield* client
            .get(`${pagesRoute(where)}/history/${path}`, HistoryJson, params)
            .pipe(orEmpty({ total: 0, versions: [] } as typeof HistoryJson.Type));
          if (json.versions.length === 0) break;
          versions.push(...json.versions);
          total = json.total;
        } while (versions.length < total);
        if (versions.length === 0) return [];
        // ai-memory stamps the author in the page's frontmatter, so only the latest version names one.
        const latest = yield* pageOf(scope, path);
        return versions.map((version) => ({
          version: MemoryVersion.make(version.id),
          author: version.is_latest ? (latest?.author ?? null) : null,
          writtenAt: version.created_at,
          latest: version.is_latest,
        }));
      }).pipe(refusalIsOutage),
    write: (actor, scope, draft, expected) =>
      client
        .tool(
          callerOf(actor),
          "memory_write_page",
          {
            ...target(scope, engineProjectOf(scope)),
            path: draft.path,
            body: draft.markdown,
            tags: draft.tags,
            pinned: draft.pinned,
            ...preconditionOf(expected),
          },
          WrittenJson,
        )
        .pipe(
          Effect.map((json) => MemoryVersion.make(json.page_id)),
          Effect.catchTag("EngineRefused", conflictOf(draft.path)),
          refusalIsOutage,
        ),
    forget: (_actor, scope, path, expected) => {
      if (expected._tag === "New") {
        return refusalIsOutage(
          Effect.flatMap(pageOf(scope, path), (page) =>
            page === null ? Effect.succeed(null) : currentConflict(scope, path),
          ),
        );
      }
      const where = engineProjectOf(scope);
      return client.tool(ROOT, "memory_delete_page", { ...where, path, ...preconditionOf(expected) }, DeletedJson).pipe(
        Effect.map((json) => {
          if (!json.deleted) return null;
          // With nothing to checkpoint first, the revision before the delete is its parent.
          const revision = json.pre_checkpoint ?? (json.checkpoint === null ? null : `${json.checkpoint}~1`);
          return revision === null ? null : MemoryVersion.make(`${REVISION}${revision}`);
        }),
        Effect.catchTag("EngineRefused", conflictOf(path)),
        orEmpty(null),
        refusalIsOutage,
      );
    },
    restore: (_actor, scope, path, version) => {
      const source = version.startsWith(REVISION) ? { rev: version.slice(REVISION.length) } : { page_id: version };
      return client.admin("restore-page", { ...engineProjectOf(scope), path, ...source }, WrittenJson).pipe(
        Effect.map((json) => MemoryVersion.make(json.page_id)),
        // A version the page never had, or one gone with a forget, leaves the page as it is.
        Effect.catchTag("EngineRefused", () => currentConflict(scope, path)),
        refusalIsOutage,
      );
    },
    health: client.health,
  };
  return store;
};

const preconditionOf = (expected: MemoryExpected): Record<string, unknown> => {
  switch (expected._tag) {
    case "Any":
      return {};
    case "New":
      return { create_only: true };
    case "Version":
      return { expected_page_id: expected.version };
  }
};

/** `MemoryStore` on the bundled ai-memory, through `MemoryEngine`'s endpoint, guarded for every caller. */
export const MemoryStoreAiMemory = Layer.effect(
  MemoryStore,
  Effect.map(makeEngineClient, (client) => MemoryStore.of(guardMemoryStore(makeStore(client)))),
);
