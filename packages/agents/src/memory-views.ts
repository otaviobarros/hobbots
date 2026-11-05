import {
  type MemoryActor,
  type MemoryChange,
  type MemoryPageSummary,
  type MemoryScope,
  type MemoryUnavailable,
  memoryScopeKey,
} from "@hobbots/domain";
import { DateTime, Duration, Effect, Ref, Semaphore } from "effect";
import type { MemoryStoreShape } from "./memory.ts";

/**
 * What the Memory page reads of memory, over `MemoryStore` and as you (ADR 028): how many pages each
 * scope holds, and the changes What changed lists. ai-memory sends no events, so the changes come
 * from asking it, about once a minute, what changed since it was last asked.
 */

const YOU: MemoryActor = { _tag: "You" };

/** The most pages a scope's count reads; a scope with more shows this many. */
export const MEMORY_SCOPE_LIMIT = 500;

/** A scope and how many pages it holds. */
export interface MemoryScopeCount {
  readonly scope: MemoryScope;
  readonly pages: number;
}

/** Every scope that holds a page, with its count. */
export const memoryScopeCounts = (
  store: MemoryStoreShape,
): Effect.Effect<ReadonlyArray<MemoryScopeCount>, MemoryUnavailable> =>
  Effect.flatMap(store.scopes(YOU), (scopes) =>
    Effect.forEach(
      scopes,
      (scope) => Effect.map(store.list(YOU, scope, MEMORY_SCOPE_LIMIT), (pages) => ({ scope, pages: pages.length })),
      { concurrency: 4 },
    ),
  );

/** How the change watch keeps what it found. */
export interface MemoryWatchOptions {
  /** How far back the first look reaches. */
  readonly lookback: Duration.Duration;
  /** How many changes it keeps, newest first. */
  readonly keep: number;
}

export const MEMORY_WATCH_DEFAULTS: MemoryWatchOptions = { lookback: Duration.days(7), keep: 200 };

/**
 * Each look starts this long before the last one did, so a page written while the last look ran is
 * never missed. A change found twice is listed once.
 */
const OVERLAP = Duration.seconds(5);

const changeKey = (change: Pick<MemoryChange, "scope" | "path" | "version">) =>
  `${memoryScopeKey(change.scope)}\n${change.path}\n${change.version}`;

interface WatchState {
  /** When the last look started, or null before the first. */
  readonly since: DateTime.Utc | null;
  /** The changes kept, newest first. */
  readonly kept: ReadonlyArray<MemoryChange>;
  /** Every change the last look found. */
  readonly lastSeen: ReadonlySet<string>;
}

/** The changes memory made, as one watch keeps them. */
export interface MemoryChangeWatch {
  /** Asks memory what changed since the last look, keeps it, and answers only what is new. */
  readonly look: Effect.Effect<ReadonlyArray<MemoryChange>, MemoryUnavailable>;
  /** Every change kept, newest first; the first call looks first. */
  readonly recent: Effect.Effect<ReadonlyArray<MemoryChange>, MemoryUnavailable>;
}

/**
 * A watch over `store`'s changes. Each look asks every scope for the pages changed since the last
 * look, reads each one for its version and author, and keeps the versions it had not seen.
 */
export const makeMemoryChangeWatch = (
  store: MemoryStoreShape,
  options: MemoryWatchOptions = MEMORY_WATCH_DEFAULTS,
): Effect.Effect<MemoryChangeWatch> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<WatchState>({ since: null, kept: [], lastSeen: new Set() });
    // One look at a time, so two callers never keep the same change twice.
    const lock = yield* Semaphore.make(1);

    const changeOf = (summary: MemoryPageSummary) =>
      Effect.map(store.page(YOU, summary.scope, summary.path), (page): MemoryChange | null =>
        page === null
          ? null
          : {
              scope: summary.scope,
              path: summary.path,
              title: summary.title,
              version: page.version,
              author: page.author,
              at: page.updatedAt,
            },
      );

    const look = Semaphore.withPermit(
      lock,
      Effect.gen(function* () {
        const started = yield* DateTime.now;
        const { since, kept, lastSeen } = yield* Ref.get(state);
        const from = DateTime.formatIso(
          since === null
            ? DateTime.subtractDuration(started, options.lookback)
            : DateTime.subtractDuration(since, OVERLAP),
        );
        const scopes = yield* store.scopes(YOU);
        const changed = (yield* Effect.forEach(scopes, (scope) => store.changes(YOU, scope, from), {
          concurrency: 4,
        })).flat();
        const found = (yield* Effect.forEach(changed, changeOf, { concurrency: 4 })).filter(
          (change): change is MemoryChange => change !== null,
        );
        // What the last look found, kept or not, so a change it already listed is never new again.
        const seen = new Set([...lastSeen, ...kept.map(changeKey)]);
        const fresh = [
          ...new Map(
            found.filter((change) => !seen.has(changeKey(change))).map((change) => [changeKey(change), change]),
          ).values(),
        ].sort((a, b) => b.at.localeCompare(a.at));
        yield* Ref.set(state, {
          since: started,
          kept: [...fresh, ...kept].sort((a, b) => b.at.localeCompare(a.at)).slice(0, options.keep),
          lastSeen: new Set(found.map(changeKey)),
        });
        return fresh;
      }),
    );

    const recent = Effect.gen(function* () {
      if ((yield* Ref.get(state)).since === null) yield* look;
      return (yield* Ref.get(state)).kept;
    });

    return { look, recent };
  });
