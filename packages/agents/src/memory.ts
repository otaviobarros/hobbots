import {
  type AgentId,
  type Committed,
  type EventEnvelope,
  type MemoryActor,
  type MemoryConflict,
  type MemoryDraft,
  type MemoryExpected,
  type MemoryHit,
  type MemoryPage,
  type MemoryPageSummary,
  type MemoryPageVersion,
  type MemoryPath,
  type MemoryProjectIdentity,
  type MemorySave,
  type MemorySaveState,
  type MemoryScope,
  type MemoryUnavailable,
  type MemoryVersion,
  type MemoryVersionChanges,
  memoryProjectIdentity,
  memoryScopeAllowed,
} from "@hobbots/domain";
import { Context, Effect, Option } from "effect";
import type { CharmTurn } from "./charms.ts";
import type { HubToolAnswer, HubTools } from "./runtime.ts";

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
   * What `version` of the page at `path` changed against the version it replaced, or null when the
   * page has no such version: what the Memory page shows for a version in its History.
   */
  readonly versionChanges: (
    actor: MemoryActor,
    scope: MemoryScope,
    path: MemoryPath,
    version: MemoryVersion,
  ) => Memory<MemoryVersionChanges | null>;
  /** The first `limit` pages in `scope`: pinned first, then the most recently changed. */
  readonly list: (actor: MemoryActor, scope: MemoryScope, limit: number) => Memory<ReadonlyArray<MemoryPageSummary>>;
  /** Every scope that holds a page now, among those `actor` may reach. */
  readonly scopes: (actor: MemoryActor) => Memory<ReadonlyArray<MemoryScope>>;
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
  versionChanges: guarded("read", store.versionChanges, one),
  list: guarded("list", store.list, one),
  // Nothing to refuse: what the engine answers is narrowed to what the actor may reach.
  scopes: (actor) =>
    Effect.map(store.scopes(actor), (found) => found.filter((scope) => memoryScopeAllowed(actor, scope))),
  changes: guarded("list", store.changes, one),
  history: guarded("read", store.history, one),
  write: guarded("write", store.write, one),
  forget: guarded("forget", store.forget, one),
  restore: guarded("restore", store.restore, one),
  health: store.health,
});

export interface MemoryProjectsShape {
  /** Who `folder` is across clones: its Git `origin` remote, or its name when it has none. */
  readonly of: (folder: string) => Effect.Effect<MemoryProjectIdentity>;
}

/**
 * The project identity of each folder a hob works in (ADR 028), read by the hub from the folder
 * itself, never from a tool's input.
 */
export class MemoryProjects extends Context.Service<MemoryProjects, MemoryProjectsShape>()(
  "@hobbots/agents/MemoryProjects",
) {}

const folderName = (folder: string) => folder.replace(/[/\\]+$/, "").replace(/^.*[/\\]/, "");

/**
 * The actor a hob's memory calls are made as: the hob, with the projects of the folders it works in,
 * once each. Without `MemoryProjects`, each folder is the project of its name.
 */
export const memoryActorFor = (
  projects: Option.Option<MemoryProjectsShape>,
  agentId: AgentId,
  folders: ReadonlyArray<string>,
): Effect.Effect<Extract<MemoryActor, { _tag: "Hob" }>> =>
  Effect.forEach(folders, (folder) =>
    Option.isSome(projects)
      ? projects.value.of(folder)
      : Effect.succeed(memoryProjectIdentity(null, folderName(folder))),
  ).pipe(Effect.map((identities) => ({ _tag: "Hob", agentId, projects: [...new Set(identities)] })));

/** What recording a save found: it is new, and journaled, or the hob used its key before in the same work. */
export type MemorySaveStart =
  | { readonly _tag: "Started"; readonly entries: ReadonlyArray<EventEnvelope> }
  | { readonly _tag: "Existing"; readonly save: MemorySave };

/**
 * The record of every `memory_save` to a hob's own memory (ADR 028). A save is recorded, and
 * journaled, before it is sent: the journal is the outbox, so a save memory could not take is kept,
 * and the capture worker sends it once memory is back. A retried key returns the first save.
 */
export class MemorySaves extends Context.Service<
  MemorySaves,
  {
    /**
     * Records `save`, in `sending`, and journals it, unless the hob's key is already taken in the same
     * work or in `also`: that save is returned instead, and nothing is written.
     */
    readonly begin: (save: MemorySave, also?: string) => Effect.Effect<MemorySaveStart>;
    /**
     * Moves a save that is still `sending` or `queued` to `state`, with the version memory answered,
     * and journals it. None when it has settled already, so a late outcome never overwrites a settled one.
     */
    readonly settle: (
      save: MemorySave,
      state: Exclude<MemorySaveState, "sending">,
      version: MemoryVersion | null,
      at: string,
    ) => Effect.Effect<Option.Option<Committed<MemorySave>>>;
    /**
     * The saves still to send, oldest first: those memory did not take, and those a hub stopped
     * while sending. For the capture worker, which sends them with the same key.
     */
    readonly unsent: Effect.Effect<ReadonlyArray<MemorySave>>;
  }
>()("@hobbots/agents/MemorySaves") {}

/** A `memory_save` that asks to share a page beyond the hob's own memory, as the hub worked it out. */
export interface MemoryShareRequest {
  readonly actor: Extract<MemoryActor, { readonly _tag: "Hob" }>;
  readonly scope: Exclude<MemoryScope, { readonly _tag: "Hob" }>;
  readonly draft: MemoryDraft;
  /** The SHA-256 of the call's key, never its text. */
  readonly key: string;
  readonly turn: CharmTurn;
}

/**
 * Shares the hobs ask for (ADR 028, Sharing): the safety preset decides whether a share goes through
 * or waits for your review. Absent, the hub takes no shares, and a hob saves to its own memory only.
 */
export class MemoryShares extends Context.Service<
  MemoryShares,
  { readonly share: (request: MemoryShareRequest) => Effect.Effect<HubToolAnswer> }
>()("@hobbots/agents/MemoryShares") {}

/**
 * The memory tools a turn offers its runtime (ADR 028), served on the hub, which alone reaches memory.
 * The hub decides every call under the hob's Memory policy group. Absent, a turn offers none.
 */
export class MemoryTools extends Context.Service<
  MemoryTools,
  {
    /** The tools the turn offers, read at its start: none (null) for a hob without tools. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/MemoryTools") {}
