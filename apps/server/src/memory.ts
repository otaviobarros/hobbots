import {
  type MemoryChangeWatch,
  MemoryStore,
  type MemoryStoreShape,
  makeMemoryChangeWatch,
  memoryScopeCounts,
} from "@hobbots/agents";
import { HobbotsApi, MemoryNotAnswering, MemoryPageChanged, MemoryPageNotFound } from "@hobbots/api";
import {
  type MemoryActor,
  type MemoryConflict,
  type MemoryPageRef,
  type MemoryPath,
  type MemoryScope,
  type MemoryUnavailable,
  memoryScopeOfKey,
} from "@hobbots/domain";
import { makeMemoryStoreOff } from "@hobbots/memory";
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { EventBus } from "./event-bus.ts";

/**
 * The Memory page's reads and changes (ADR 028): every one goes through the hub, as you, and an
 * engine that does not answer is `MemoryNotAnswering`, never an empty memory. A change made against a
 * version that is no longer the latest, as when a hob saved the page meanwhile, writes nothing and is
 * `MemoryPageChanged`. What changed comes from the hub's own watch, which asks memory about once a
 * minute, and right after each of your changes, and streams what it finds as `MemoryChanged`.
 */

const YOU: MemoryActor = { _tag: "You" };

/** How many hits a search answers. */
const SEARCH_LIMIT = 50;

/** How many pages a scope's list answers. */
const PAGES_LIMIT = 500;

/** How often the hub asks memory what changed: ai-memory sends no events of its own. */
const MEMORY_LOOK_EVERY = Duration.minutes(1);

/** The hub's watch over memory's changes, shared by every client. */
export class MemoryChanges extends Context.Service<
  MemoryChanges,
  MemoryChangeWatch & {
    /** Looks now and streams what is new, as each timed look does; a look that fails finds nothing. */
    readonly lookNow: Effect.Effect<void>;
    /** Streams that a page was deleted, which no look can find, so every client drops it. */
    readonly deleted: (page: MemoryPageRef) => Effect.Effect<void>;
  }
>()("@hobbots/server/MemoryChanges") {
  /**
   * The watch, and the fiber that looks every `every` and streams each new change as
   * `MemoryChanged`. A look while memory does not answer finds nothing and the next one tries again.
   */
  static readonly layer = (every: Duration.Duration = MEMORY_LOOK_EVERY) =>
    Layer.effect(
      MemoryChanges,
      Effect.gen(function* () {
        const watch = yield* makeMemoryChangeWatch(yield* MemoryStore);
        const bus = yield* EventBus;
        const lookOnce = watch.look.pipe(
          Effect.flatMap((changes) =>
            changes.length === 0 ? Effect.void : bus.publishTransient({ _tag: "MemoryChanged", changes }),
          ),
          Effect.catchTag("MemoryUnavailable", () => Effect.void),
        );
        yield* Effect.forkScoped(Effect.repeat(lookOnce, Schedule.spaced(every)));
        return MemoryChanges.of({
          ...watch,
          lookNow: lookOnce,
          deleted: (page) => bus.publishTransient({ _tag: "MemoryChanged", changes: [], deleted: [page] }),
        });
      }),
    );
}

const notAnswering = (_: MemoryUnavailable) => Effect.fail(new MemoryNotAnswering());
const changed = (conflict: MemoryConflict) =>
  Effect.fail(new MemoryPageChanged({ path: conflict.path, current: conflict.current }));

/** The scope a decoded key names; the API's Schema only lets through keys that name one. */
const scopeOf = (key: string): MemoryScope => memoryScopeOfKey(key) as MemoryScope;

export const MemoryPagesHandlers = HttpApiBuilder.group(HobbotsApi, "memoryPages", (handlers) =>
  Effect.gen(function* () {
    // A hub built without memory, as most tests build it, answers that memory is not answering.
    const store: MemoryStoreShape = Option.getOrElse(yield* Effect.serviceOption(MemoryStore), () =>
      makeMemoryStoreOff("This hub has no memory."),
    );
    const changes = Option.getOrElse(yield* Effect.serviceOption(MemoryChanges), () => null);
    const watch = changes ?? (yield* makeMemoryChangeWatch(store));
    // What changed lists your change at once, for every client, rather than at the next timed look.
    const lookNow = changes?.lookNow ?? watch.look.pipe(Effect.ignore);
    const deleted = changes?.deleted ?? (() => Effect.void);
    /** A page as it is now, with its History, or null when there is none. */
    const readOf = (scope: MemoryScope, path: MemoryPath) =>
      Effect.gen(function* () {
        const page = yield* store.page(YOU, scope, path);
        return page === null ? null : { page, history: yield* store.history(YOU, scope, path) };
      });
    /** The page a change wrote; gone already, it changed again since. */
    const pageRead = (scope: MemoryScope, path: MemoryPath) =>
      Effect.flatMap(readOf(scope, path), (read) =>
        read === null ? Effect.fail(new MemoryPageChanged({ path, current: null })) : Effect.succeed(read),
      );
    return handlers.handleAll({
      scopes: () =>
        memoryScopeCounts(store).pipe(
          Effect.map((scopes) => ({ scopes })),
          Effect.catchTag("MemoryUnavailable", notAnswering),
        ),
      changes: () => watch.recent.pipe(Effect.catchTag("MemoryUnavailable", notAnswering)),
      pages: ({ query }) =>
        store.list(YOU, scopeOf(query.scope), PAGES_LIMIT).pipe(Effect.catchTag("MemoryUnavailable", notAnswering)),
      page: ({ query }) =>
        readOf(scopeOf(query.scope), query.path).pipe(
          Effect.flatMap((read) =>
            read === null ? Effect.fail(new MemoryPageNotFound({ path: query.path })) : Effect.succeed(read),
          ),
          Effect.catchTag("MemoryUnavailable", notAnswering),
        ),
      version: ({ query }) =>
        store.versionChanges(YOU, scopeOf(query.scope), query.path, query.version).pipe(
          Effect.flatMap((changes) =>
            changes === null ? Effect.fail(new MemoryPageNotFound({ path: query.path })) : Effect.succeed(changes),
          ),
          Effect.catchTag("MemoryUnavailable", notAnswering),
        ),
      search: ({ query }) =>
        Effect.gen(function* () {
          const scopes = query.scope === undefined ? yield* store.scopes(YOU) : [scopeOf(query.scope)];
          return yield* store.search(YOU, scopes, query.q, SEARCH_LIMIT);
        }).pipe(Effect.catchTag("MemoryUnavailable", notAnswering)),
      save: ({ payload }) =>
        Effect.gen(function* () {
          const scope = scopeOf(payload.scope);
          const { path, markdown, tags, pinned, forgetOn, expected } = payload;
          yield* store.write(
            YOU,
            scope,
            { path, markdown, tags, pinned, forgetOn },
            expected === null ? { _tag: "New" } : { _tag: "Version", version: expected },
          );
          yield* lookNow;
          return yield* pageRead(scope, path);
        }).pipe(Effect.catchTags({ MemoryUnavailable: notAnswering, MemoryConflict: changed })),
      delete: ({ payload }) =>
        store.forget(YOU, scopeOf(payload.scope), payload.path, { _tag: "Version", version: payload.version }).pipe(
          Effect.map((restoreFrom) => ({ restoreFrom })),
          Effect.tap(() => deleted({ scope: scopeOf(payload.scope), path: payload.path })),
          Effect.tap(() => lookNow),
          Effect.catchTags({ MemoryUnavailable: notAnswering, MemoryConflict: changed }),
        ),
      restore: ({ payload }) =>
        Effect.gen(function* () {
          const scope = scopeOf(payload.scope);
          yield* store.restore(YOU, scope, payload.path, payload.version);
          yield* lookNow;
          return yield* pageRead(scope, payload.path);
        }).pipe(Effect.catchTags({ MemoryUnavailable: notAnswering, MemoryConflict: changed })),
    });
  }),
);
