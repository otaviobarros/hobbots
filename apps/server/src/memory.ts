import {
  type MemoryChangeWatch,
  MemoryStore,
  type MemoryStoreShape,
  makeMemoryChangeWatch,
  memoryScopeCounts,
} from "@hobbots/agents";
import { HobbotsApi, MemoryNotAnswering, MemoryPageNotFound } from "@hobbots/api";
import { type MemoryActor, type MemoryScope, type MemoryUnavailable, memoryScopeOfKey } from "@hobbots/domain";
import { makeMemoryStoreOff } from "@hobbots/memory";
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { EventBus } from "./event-bus.ts";

/**
 * The Memory page's reads (ADR 028): every one goes through the hub, as you, and an engine that does
 * not answer is `MemoryNotAnswering`, never an empty memory. What changed comes from the hub's own
 * watch, which asks memory about once a minute and streams what it finds as `MemoryChanged`.
 */

const YOU: MemoryActor = { _tag: "You" };

/** How many hits a search answers. */
const SEARCH_LIMIT = 50;

/** How many pages a scope's list answers. */
const PAGES_LIMIT = 500;

/** How often the hub asks memory what changed: ai-memory sends no events of its own. */
const MEMORY_LOOK_EVERY = Duration.minutes(1);

/** The hub's watch over memory's changes, shared by every client. */
export class MemoryChanges extends Context.Service<MemoryChanges, MemoryChangeWatch>()(
  "@hobbots/server/MemoryChanges",
) {
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
        return MemoryChanges.of(watch);
      }),
    );
}

const notAnswering = (_: MemoryUnavailable) => Effect.fail(new MemoryNotAnswering());

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
        Effect.gen(function* () {
          const scope = scopeOf(query.scope);
          const page = yield* store.page(YOU, scope, query.path);
          if (page === null) return yield* new MemoryPageNotFound({ path: query.path });
          const history = yield* store.history(YOU, scope, query.path);
          return { page, history };
        }).pipe(Effect.catchTag("MemoryUnavailable", notAnswering)),
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
    });
  }),
);
