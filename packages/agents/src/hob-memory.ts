import type { Agent, Committed, MemoryActor, MemorySave, MemoryScope, MemoryUnavailable } from "@hobbots/domain";
import { Effect, Option, Schema } from "effect";
import { MemoryProjects, type MemorySaves, type MemoryStoreShape, memoryActorFor } from "./memory.ts";
import { MEMORY_SCOPE_LIMIT, type MemoryScopeCount } from "./memory-views.ts";
import { hobFoldersNow } from "./permissions.ts";
import { FolderChecks, InstallationSettings } from "./ports.ts";

/**
 * Memory as a chat and a hob's page show it (ADR 028, #961): the saves a reply made, Undo for one of
 * them, and what a hob reads. Everything goes through `MemoryStore` as you, as the Memory page does.
 */

const YOU: MemoryActor = { _tag: "You" };

/**
 * Why a save cannot be undone: there is no such save, it never reached memory, it was undone
 * already, or the page changed after it, by a later save or by you, so Undo would throw that away.
 */
export class MemoryUndoRefused extends Schema.TaggedError<MemoryUndoRefused>()("MemoryUndoRefused", {
  reason: Schema.Literals(["missing", "not-saved", "undone", "newer"]),
}) {}

/**
 * Undoes a hob's save to its own memory: the version it replaced is written back, or a page the save
 * made is removed, as you, and the save is marked undone and journaled. Only while the save is still
 * the page's latest version: a page changed since is refused, never overwritten.
 */
export const undoMemorySave = (
  store: MemoryStoreShape,
  saves: MemorySaves["Service"],
  id: string,
  at: string,
): Effect.Effect<Committed<MemorySave>, MemoryUndoRefused | MemoryUnavailable> =>
  Effect.gen(function* () {
    const save = yield* saves.find(id);
    if (save === null) return yield* new MemoryUndoRefused({ reason: "missing" });
    if (save.undoneAt !== undefined) return yield* new MemoryUndoRefused({ reason: "undone" });
    if (save.state !== "saved" || save.version === null) return yield* new MemoryUndoRefused({ reason: "not-saved" });
    const version = save.version;
    // Newest first. The save must still be the latest version, or Undo would discard a later one.
    const history = yield* store.history(YOU, save.scope, save.path);
    const index = history.findIndex((entry) => entry.version === version);
    if (index === -1 || history[index]?.latest !== true) return yield* new MemoryUndoRefused({ reason: "newer" });
    const before = history[index + 1];
    // Both are conditional on the save's version, so a change that lands after the history read is
    // refused rather than overwritten.
    const still = { _tag: "Version", version } as const;
    yield* (
      before === undefined
        ? store.forget(YOU, save.scope, save.path, still)
        : store.restore(YOU, save.scope, save.path, before.version, still)
    ).pipe(Effect.catchTag("MemoryConflict", () => new MemoryUndoRefused({ reason: "newer" })));
    const marked = yield* saves.markUndone(save.id, at);
    if (Option.isNone(marked)) return yield* new MemoryUndoRefused({ reason: "undone" });
    return marked.value;
  });

/**
 * The scopes `agent` reads, with how many pages each holds: its own memory, About you, then the
 * project of each folder it works in now, as its turns' memory tools reach them (ADR 028).
 */
export const hobMemoryScopes = (
  store: MemoryStoreShape,
  agent: Agent,
): Effect.Effect<ReadonlyArray<MemoryScopeCount>, MemoryUnavailable, InstallationSettings | FolderChecks> =>
  Effect.gen(function* () {
    const { approvedFolders } = yield* (yield* InstallationSettings).get;
    const folders = yield* hobFoldersNow(yield* FolderChecks, approvedFolders, agent.policy);
    const actor = yield* memoryActorFor(yield* Effect.serviceOption(MemoryProjects), agent.id, folders);
    const scopes: ReadonlyArray<MemoryScope> = [
      { _tag: "Hob", agentId: agent.id },
      { _tag: "Everyone" },
      ...actor.projects.map((identity) => ({ _tag: "Project", identity }) as const),
    ];
    return yield* Effect.forEach(
      scopes,
      (scope) => Effect.map(store.list(YOU, scope, MEMORY_SCOPE_LIMIT), (pages) => ({ scope, pages: pages.length })),
      { concurrency: 4 },
    );
  });
