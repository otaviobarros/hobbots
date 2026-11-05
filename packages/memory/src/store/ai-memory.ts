import { guardMemoryStore, MemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import {
  type MemoryActor,
  type MemoryChangedLine,
  MemoryConflict,
  type MemoryDraft,
  type MemoryExpected,
  MemoryForgetDay,
  type MemoryHit,
  type MemoryPage,
  type MemoryPageSummary,
  MemoryPath,
  MemoryProjectIdentity,
  type MemoryScope,
  MemoryUnavailable,
  MemoryVersion,
  type MemoryVersionChanges,
  memoryTitleOf,
  searchTerms,
  type ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option, Schema, Semaphore } from "effect";
import { acknowledgedPrefix, HOOK_BATCH_MAX, HookBatchJson, hookEventOf } from "./capture.ts";
import {
  type EngineCaller,
  type EngineClient,
  type EngineRefused,
  makeEngineClient,
  noSuchProject,
  ROOT,
} from "./client.ts";
import { applyHunks } from "./patch.ts";
import {
  authorOfUsername,
  type EngineProject,
  engineActorOf,
  engineProjectOf,
  INDEX_PROJECT,
  scopeOfEngineProject,
} from "./scopes.ts";

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
    expires_at: Schema.optionalKey(Schema.String),
    last_modified_by: Schema.optionalKey(Schema.Struct({ username: Schema.optionalKey(Schema.String) })),
  }),
});
const SummaryJson = Schema.Struct({ path: Schema.String, title: Schema.String, updated_at: Schema.String });
const ChangesJson = Schema.Struct({ pages: Schema.Array(SummaryJson), next_cursor: Schema.NullOr(Schema.String) });
const HistoryJson = Schema.Struct({
  total: Schema.Number,
  versions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      is_latest: Schema.Boolean,
      created_at: Schema.String,
    }),
  ),
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
const DiffJson = Schema.Struct({
  diff: Schema.Struct({
    from: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    status: Schema.String,
    truncated: Schema.optionalKey(Schema.Boolean),
    hunks: Schema.optionalKey(
      Schema.Array(Schema.Struct({ lines: Schema.Array(Schema.Struct({ op: Schema.String, text: Schema.String })) })),
    ),
  }),
});
/** A diff between two versions, with where each hunk starts, to rebuild one version from another. */
const PatchJson = Schema.Struct({
  diff: Schema.Struct({
    status: Schema.String,
    truncated: Schema.optionalKey(Schema.Boolean),
    hunks: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          old_start: Schema.Number,
          old_len: Schema.Number,
          lines: Schema.Array(Schema.Struct({ op: Schema.String, text: Schema.String })),
        }),
      ),
    ),
  }),
});
const ProjectsJson = Schema.Array(
  Schema.Struct({ workspace_name: Schema.String, project_name: Schema.String, page_count: Schema.Number }),
);
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

const OPS: Record<string, MemoryChangedLine["op"]> = { "+": "add", "-": "remove", " ": "same" };

/** What a version changed, from the diff ai-memory answers against the version it replaced. */
const changesOf = (json: typeof DiffJson.Type): MemoryVersionChanges => ({
  first: json.diff.from === null,
  lines: (json.diff.hunks ?? []).flatMap((hunk) =>
    hunk.lines.flatMap((line) => {
      const op = OPS[line.op];
      return op === undefined ? [] : [{ op, text: line.text }];
    }),
  ),
  // A diff too large to answer has no lines; one cut short says so.
  cut: json.diff.status === "too_large" || json.diff.truncated === true,
});

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
  /**
   * The hub's changes to memory run one at a time, so none of them lands between a restore's check
   * of the page and the engine's restore, which takes no precondition of its own.
   */
  const changing = Semaphore.makeUnsafe(1);
  /**
   * A project's engine name is hashed, so the identity it holds is kept in the index project, one
   * page per project, written before the project's first page: `scopes` reads it back.
   */
  const indexed = new Set<string>();
  const indexProject = (scope: MemoryScope) => {
    if (scope._tag !== "Project") return Effect.void;
    const { project } = engineProjectOf(scope);
    if (indexed.has(project)) return Effect.void;
    return client
      .tool(
        ROOT,
        "memory_write_page",
        { ...INDEX_PROJECT, path: `${project}.md`, body: scope.identity, tags: [], pinned: false, create_only: true },
        WrittenJson,
      )
      .pipe(
        Effect.asVoid,
        // Already indexed by an earlier run.
        Effect.catchTag("EngineRefused", (refused) =>
          Schema.decodeUnknownOption(PreconditionJson)(refused.data)._tag === "Some"
            ? Effect.void
            : Effect.fail(refused),
        ),
        Effect.tap(() => Effect.sync(() => indexed.add(project))),
      );
  };
  const identityOf = (project: string) =>
    client.get(`${pagesRoute(INDEX_PROJECT)}/pages/${project}.md`, PageJson).pipe(
      Effect.map((json) => {
        const text = json.body_markdown.trim();
        if (text.length === 0) return null;
        const identity = MemoryProjectIdentity.make(text);
        // The page names the project only when the identity hashes to it again.
        return engineProjectOf({ _tag: "Project", identity }).project === project ? identity : null;
      }),
      orEmpty(null),
    );

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
        forgetOn: forgetDayOf(json.frontmatter.expires_at),
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

  /** Writes `draft` when the page is as `expected`; `write` and `restore` hold `changing` around it. */
  const writePage = (actor: MemoryActor, scope: MemoryScope, draft: MemoryDraft, expected: MemoryExpected) =>
    indexProject(scope)
      .pipe(
        Effect.andThen(
          client.tool(
            callerOf(actor),
            "memory_write_page",
            {
              ...target(scope, engineProjectOf(scope)),
              path: draft.path,
              body: draft.markdown,
              tags: draft.tags,
              pinned: draft.pinned,
              ...(draft.forgetOn ? { expires_at: draft.forgetOn } : {}),
              ...preconditionOf(expected),
            },
            WrittenJson,
          ),
        ),
      )
      .pipe(
        Effect.map((json) => MemoryVersion.make(json.page_id)),
        Effect.catchTag("EngineRefused", conflictOf(draft.path)),
        refusalIsOutage,
      );

  /**
   * The text of `version` of the page, rebuilt from `current` and the line diff ai-memory answers
   * between them, or null when it cannot be rebuilt whole: a diff cut short, or one that does not fit.
   */
  const versionText = (scope: MemoryScope, current: MemoryPage, version: MemoryVersion) =>
    Effect.map(
      client.get(`${pagesRoute(engineProjectOf(scope))}/history/${current.path}`, PatchJson, {
        from: current.version,
        to: version,
        limit: "1",
      }),
      ({ diff }) =>
        diff.truncated === true || diff.status === "too_large" ? null : applyHunks(current.markdown, diff.hunks ?? []),
    );

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
    versionChanges: (_actor, scope, path, version) =>
      client.get(`${pagesRoute(engineProjectOf(scope))}/history/${path}`, DiffJson, { to: version, limit: "1" }).pipe(
        Effect.map((json): MemoryVersionChanges | null => changesOf(json)),
        // An unknown version is a 404 and a malformed one a 400: neither is a version of this page.
        Effect.catchTag("EngineRefused", (refused) =>
          refused.status === 404 || refused.status === 400 ? Effect.succeed(null) : Effect.fail(refused),
        ),
        refusalIsOutage,
      ),
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
    write: (actor, scope, draft, expected) => changing.withPermit(writePage(actor, scope, draft, expected)),
    scopes: () =>
      Effect.gen(function* () {
        const projects = yield* client.get("projects", ProjectsJson);
        const held = projects.filter((each) => each.page_count > 0);
        const found = yield* Effect.forEach(
          held,
          (each): Effect.Effect<MemoryScope | null, MemoryUnavailable | EngineRefused> => {
            const known = scopeOfEngineProject({ workspace: each.workspace_name, project: each.project_name });
            if (known !== "Project") return Effect.succeed(known);
            return Effect.flatMap(identityOf(each.project_name), (identity) =>
              identity === null
                ? Effect.fail(unnamed(each.project_name))
                : Effect.succeed({ _tag: "Project" as const, identity }),
            );
          },
          { concurrency: READ_CONCURRENCY },
        );
        // A scope whose pages were all forgotten holds nothing to name.
        const named = found.filter((scope): scope is MemoryScope => scope !== null);
        return yield* Effect.filter(named, (scope) =>
          Effect.map(
            client
              .get(`${pagesRoute(engineProjectOf(scope))}/recent`, Schema.Array(SummaryJson), { limit: "1" })
              .pipe(orEmpty([] as ReadonlyArray<typeof SummaryJson.Type>)),
            (recent) => recent.length > 0,
          ),
        );
      }).pipe(refusalIsOutage),
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
        changing.withPermit,
      );
    },
    restore: (actor, scope, path, version, expected) =>
      Effect.gen(function* () {
        const current = yield* pageOf(scope, path);
        const was = current?.version ?? null;
        if (!pageMeets(was, expected)) return yield* new MemoryConflict({ path, current: was });
        // A restore that must find the page at a version is a write of yours that the engine itself
        // makes conditional on that version, so a change since, by anyone, the engine included, is
        // refused and kept. The engine's own restore takes no precondition, so it never serves one.
        if (current !== null && expected._tag === "Version") {
          if (version.startsWith(REVISION)) return yield* new MemoryConflict({ path, current: was });
          const markdown = yield* versionText(scope, current, version);
          if (markdown === null) return yield* new MemoryConflict({ path, current: was });
          const draft = { path, markdown, tags: current.tags, pinned: current.pinned, forgetOn: current.forgetOn };
          return yield* writePage(actor, scope, draft, expected);
        }
        // Otherwise the engine's restore brings the version back whole, its tags and pin included,
        // from its history or, for a forgotten page, from Git. The hub's own changes wait meanwhile.
        const source = version.startsWith(REVISION) ? { rev: version.slice(REVISION.length) } : { page_id: version };
        const json = yield* client
          .admin("restore-page", { ...engineProjectOf(scope), path, ...source }, WrittenJson)
          // A version the page never had, or one gone with a forget, leaves the page as it is.
          .pipe(Effect.catchTag("EngineRefused", () => currentConflict(scope, path)));
        return yield* stampedYours(actor, scope, path, MemoryVersion.make(json.page_id));
      }).pipe(refusalIsOutage, changing.withPermit),
    capture: (actor, scope, threadId, items) =>
      Effect.gen(function* () {
        const where = engineProjectOf(scope);
        let acknowledged = 0;
        // In order, one batch at a time: a batch only partly acknowledged stops the rest, which is sent again.
        while (acknowledged < items.length) {
          const batch = items.slice(acknowledged, acknowledged + HOOK_BATCH_MAX);
          const json = yield* client.hookBatch(
            callerOf(actor),
            batch.map((item) => hookEventOf(where, threadId, item)),
            HookBatchJson,
          );
          const prefix = Math.min(acknowledgedPrefix(json), batch.length);
          acknowledged += prefix;
          if (prefix < batch.length) break;
        }
        return acknowledged;
      }).pipe(refusalIsOutage),
    endSession: (actor, scope, threadId, key) =>
      Effect.flatMap(pageOf(scope, MemoryPath.make(`sessions/${threadId}.md`)), (note) =>
        // The engine writes a session's page again at every end, pinned or not, so the end of a
        // session whose chat note you pinned is not sent: the note stays as it is, and the capture
        // worker keeps the end and sends it again once you unpin it.
        note?.pinned === true ? Effect.succeed(false) : Effect.as(endOf(actor, scope, threadId, key), true),
      ).pipe(refusalIsOutage, changing.withPermit),
    health: client.health,
  };

  const endOf = (actor: MemoryActor, scope: MemoryScope, threadId: ThreadId, key: string) =>
    client
      .hookBatch(
        callerOf(actor),
        [hookEventOf(engineProjectOf(scope), threadId, { kind: "end", key, text: "" })],
        HookBatchJson,
      )
      .pipe(
        Effect.flatMap((json) =>
          acknowledgedPrefix(json) >= 1
            ? Effect.void
            : Effect.fail(new MemoryUnavailable({ message: "Memory did not take the end of a session." })),
        ),
      );

  /**
   * The engine restores a version with the frontmatter it had, the author who wrote it included, so
   * a version a hob wrote is written once more, unchanged, as you: every restore is yours in History.
   */
  const stampedYours = (actor: MemoryActor, scope: MemoryScope, path: MemoryPath, restored: MemoryVersion) =>
    Effect.flatMap(pageOf(scope, path), (page) =>
      page === null || page.version !== restored || page.author?._tag === "You"
        ? Effect.succeed(restored)
        : writePage(
            actor,
            scope,
            { path, markdown: page.markdown, tags: page.tags, pinned: page.pinned, forgetOn: page.forgetOn },
            { _tag: "Version", version: restored },
          ),
    );
  return store;
};

/** Never silently left out: an export that cannot name a project says memory did not answer in full. */
const unnamed = (project: string) =>
  new MemoryUnavailable({ message: `Memory holds a project Hobbots cannot name: ${project}` });

/** Whether a page whose latest version is `current`, or null when there is none, is as `expected`. */
const pageMeets = (current: MemoryVersion | null, expected: MemoryExpected) => {
  switch (expected._tag) {
    case "Any":
      return true;
    case "New":
      return current === null;
    case "Version":
      return current === expected.version;
  }
};

/** The day a page's `expires_at` names, or null for none, or for a time Hobbots did not write. */
const forgetDayOf = (expiresAt: string | undefined): MemoryForgetDay | null =>
  Option.getOrNull(Schema.decodeUnknownOption(MemoryForgetDay)(expiresAt?.slice(0, 10)));

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
