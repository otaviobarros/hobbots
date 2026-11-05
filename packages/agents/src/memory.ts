import {
  type MemoryActor,
  type MemoryConflict,
  type MemoryDraft,
  type MemoryExpected,
  type MemoryHit,
  type MemoryPage,
  type MemoryPageSummary,
  type MemoryPageVersion,
  type MemoryPath,
  type MemoryScope,
  type MemoryUnavailable,
  type MemoryVersion,
  memoryScopeAllowed,
} from "@hobbots/domain";
import { Context, Effect } from "effect";

type Memory<A, E = MemoryUnavailable> = Effect.Effect<A, E>;

/**
 * Memory, as everything in Hobbots talks to it (ADR 028). Its words are Hobbots' (hob, scope, page,
 * version); which engine keeps the pages, and how, is the adapter's business. Policy, such as what a
 * brief holds or whether a share needs review, is built on top of it, never inside it. Every call
 * names the actor it is made for, and is refused before it reaches the engine when that actor may not
 * touch a scope it names (`guardMemoryStore`).
 */
export interface MemoryStoreShape {
  /** Pages in `scopes` that match `query`, best first, at most `limit`. */
  readonly search: (
    actor: MemoryActor,
    scopes: ReadonlyArray<MemoryScope>,
    query: string,
    limit: number,
  ) => Memory<ReadonlyArray<MemoryHit>>;
  /** The page at `path` as it is now, or null when there is none. */
  readonly page: (actor: MemoryActor, scope: MemoryScope, path: MemoryPath) => Memory<MemoryPage | null>;
  /**
   * The page at `path` as `version` of it left it, or null when the page has no such version. The
   * Memory page reads two of them to show what a version changed.
   */
  readonly pageAt: (
    actor: MemoryActor,
    scope: MemoryScope,
    path: MemoryPath,
    version: MemoryVersion,
  ) => Memory<MemoryPage | null>;
  /** Every scope that holds a page now, that `actor` may touch: what the Memory page lists. */
  readonly scopes: (actor: MemoryActor) => Memory<ReadonlyArray<MemoryScope>>;
  /** The first `limit` pages in `scope`: pinned first, then the most recently changed. */
  readonly list: (actor: MemoryActor, scope: MemoryScope, limit: number) => Memory<ReadonlyArray<MemoryPageSummary>>;
  /** Pages in `scope` changed after `since` (an ISO date), oldest change first. */
  readonly changes: (actor: MemoryActor, scope: MemoryScope, since: string) => Memory<ReadonlyArray<MemoryPageSummary>>;
  /** Every version of the page at `path`, newest first; empty when there is no page. */
  readonly history: (
    actor: MemoryActor,
    scope: MemoryScope,
    path: MemoryPath,
  ) => Memory<ReadonlyArray<MemoryPageVersion>>;
  /** Writes `draft` as `actor` when the page is as `expected`, and answers the new version. */
  readonly write: (
    actor: MemoryActor,
    scope: MemoryScope,
    draft: MemoryDraft,
    expected: MemoryExpected,
  ) => Memory<MemoryVersion, MemoryUnavailable | MemoryConflict>;
  /**
   * Removes the page, with its history, when it is as `expected`. Answers the version that `restore`
   * brings it back from, or null when there was no page.
   */
  readonly forget: (
    actor: MemoryActor,
    scope: MemoryScope,
    path: MemoryPath,
    expected: MemoryExpected,
  ) => Memory<MemoryVersion | null, MemoryUnavailable | MemoryConflict>;
  /**
   * Writes `version` back as the latest version of the page, and answers the new version. `version` is
   * one from the page's history, or one `forget` answered.
   */
  readonly restore: (
    actor: MemoryActor,
    scope: MemoryScope,
    path: MemoryPath,
    version: MemoryVersion,
  ) => Memory<MemoryVersion, MemoryUnavailable | MemoryConflict>;
  /** Succeeds while the engine answers. */
  readonly health: Memory<void>;
}

export class MemoryStore extends Context.Service<MemoryStore, MemoryStoreShape>()("@hobbots/agents/MemoryStore") {}

/** Calls only you may make: a hob has no delete tool and never restores (ADR 028). */
const YOURS_ONLY: ReadonlySet<string> = new Set(["forget", "restore"]);

/** A call the hub should never have made: its callers build scopes from the actor. */
const refused = (actor: MemoryActor, what: string) =>
  Effect.die(
    new Error(
      actor._tag === "Hob"
        ? `Hob ${actor.agentId} may not ${what} in this memory scope.`
        : `You may not ${what} in this memory scope.`,
    ),
  );

const guarded =
  <Args extends ReadonlyArray<unknown>, A, E>(
    what: string,
    run: (actor: MemoryActor, ...args: Args) => Effect.Effect<A, E>,
    scopesOf: (args: Args) => ReadonlyArray<MemoryScope>,
  ) =>
  (actor: MemoryActor, ...args: Args): Effect.Effect<A, E> => {
    if (YOURS_ONLY.has(what) && actor._tag !== "You") return refused(actor, what);
    return scopesOf(args).every((scope) => memoryScopeAllowed(actor, scope))
      ? run(actor, ...args)
      : refused(actor, what);
  };

const one = <Args extends readonly [MemoryScope, ...ReadonlyArray<unknown>]>(args: Args) => [args[0]];

/**
 * `store`, refusing every call whose actor may not touch a scope it names, before the engine sees
 * it. Every `MemoryStore` layer is built through it, so no engine can forget the rule. A refusal is a
 * defect: the memory tools only ever name scopes the hub worked out for the hob.
 */
export const guardMemoryStore = (store: MemoryStoreShape): MemoryStoreShape => ({
  search: guarded("search", store.search, ([scopes]) => scopes),
  page: guarded("read", store.page, one),
  pageAt: guarded("read", store.pageAt, one),
  // Every scope is listed, then the ones the actor may not touch are left out, never refused.
  scopes: (actor) =>
    Effect.map(store.scopes(actor), (scopes) => scopes.filter((scope) => memoryScopeAllowed(actor, scope))),
  list: guarded("list", store.list, one),
  changes: guarded("list", store.changes, one),
  history: guarded("read", store.history, one),
  write: guarded("write", store.write, one),
  forget: guarded("forget", store.forget, one),
  restore: guarded("restore", store.restore, one),
  health: store.health,
});
