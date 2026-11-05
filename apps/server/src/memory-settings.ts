import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type RuntimeAdapters, runtimeAdapters } from "@hobbots/agents";
import { HobbotsApi, type MemoryOverview } from "@hobbots/api";
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_RUNTIMES,
  type MemoryModelState,
  MemorySettings,
  memoryModelOn,
} from "@hobbots/domain";
import { engineSettingsFor, MemoryEngine, MemoryModelEndpoint, type MemoryModelEndpointShape } from "@hobbots/memory";
import { Context, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/**
 * The memory model you chose (ADR 028), kept in `memory-settings.json` in the Hobbots data folder,
 * outside the engine's own folder: the hub reads it before it starts the engine. A missing or
 * unreadable file reads as the default.
 */
export const memorySettingsFile = (dataDir: string) => join(dataDir, "memory-settings.json");

const decodeSettings = Schema.decodeUnknownOption(MemorySettings);

export const readMemorySettings = (dataDir: string): MemorySettings => {
  try {
    return Option.getOrElse(decodeSettings(JSON.parse(readFileSync(memorySettingsFile(dataDir), "utf8"))), () => ({
      ...DEFAULT_MEMORY_SETTINGS,
    }));
  } catch {
    return DEFAULT_MEMORY_SETTINGS;
  }
};

/** Written beside the file and renamed over it, so a crash never leaves half a file. */
const writeMemorySettings = (dataDir: string, settings: MemorySettings): void => {
  const file = memorySettingsFile(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

/**
 * What memory runs with now (ADR 028): the provider's runtime as its own health and models report
 * it, through the same adapter the brain picker reads, and whether its plan refused the last memory
 * task for its limit.
 */
const memoryModelState = (
  settings: MemorySettings,
  adapters: RuntimeAdapters,
  endpoint: MemoryModelEndpointShape | undefined,
): Effect.Effect<MemoryModelState> =>
  Effect.gen(function* () {
    const provider = settings.provider;
    if (provider === "none") return { _tag: "NoAi" } as const;
    const runtime = MEMORY_RUNTIMES[provider];
    const adapter = adapters(runtime);
    if (adapter === undefined) return { _tag: "Unavailable", provider, state: "unavailable", resetsAt: null } as const;
    const health = yield* adapter.health;
    if (health.availability !== "ready")
      return { _tag: "Unavailable", provider, state: health.availability, resetsAt: null } as const;
    const limit = endpoint === undefined ? Option.none() : yield* endpoint.limited(runtime);
    if (Option.isSome(limit))
      return { _tag: "Unavailable", provider, state: "limited", resetsAt: limit.value.resetsAt } as const;
    const { model, replaced } = memoryModelOn(yield* adapter.models, settings.model);
    return { _tag: "Model", model: model?.id ?? null, replaced } as const;
  });

interface MemorySettingsStoreShape {
  readonly get: Effect.Effect<MemorySettings>;
  readonly set: (settings: MemorySettings) => Effect.Effect<void>;
  /** The size of the memory folder on the hub in bytes, or null when there is none. */
  readonly bytes: Effect.Effect<number | null>;
}

export class MemorySettingsStore extends Context.Service<MemorySettingsStore, MemorySettingsStoreShape>()(
  "@hobbots/server/MemorySettingsStore",
) {
  /**
   * The settings in the data folder, and the size of its `memory/` folder. The size is read off
   * the request path: at most once every {@link FOLDER_SIZE_TTL}, shared by every request that asks
   * meanwhile, and without blocking the hub while it walks the folder.
   */
  static readonly layer = (dataDir: string) =>
    Layer.effect(
      MemorySettingsStore,
      Effect.gen(function* () {
        const bytes = yield* Effect.cachedWithTTL(folderBytes(join(dataDir, "memory")), FOLDER_SIZE_TTL);
        return {
          get: Effect.sync(() => readMemorySettings(dataDir)),
          set: (settings) => Effect.sync(() => writeMemorySettings(dataDir, settings)),
          bytes,
        };
      }),
    );
}

/** How long a measured folder size stands before the next request measures it again. */
const FOLDER_SIZE_TTL = "30 seconds";

/** How many folder entries are read at once while the folder is measured. */
const FOLDER_CONCURRENCY = 8;

/**
 * The bytes of every file under `folder`, without following links; null when there is no folder.
 * At most {@link FOLDER_CONCURRENCY} reads of the file system run at once, however deep the folder
 * goes, and an entry that goes away while it is measured counts as nothing.
 */
export const folderBytes = (folder: string): Effect.Effect<number | null> =>
  Effect.suspend(() => {
    const permit = Semaphore.withPermit(Semaphore.makeUnsafe(FOLDER_CONCURRENCY));
    const read = <A>(call: () => Promise<A>) => permit(Effect.tryPromise(call));
    const walk = (dir: string): Effect.Effect<number, unknown> =>
      read(() => readdir(dir, { withFileTypes: true })).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries,
            (entry): Effect.Effect<number> => {
              const path = join(dir, entry.name);
              if (entry.isDirectory()) return walk(path).pipe(Effect.orElseSucceed(() => 0));
              if (!entry.isFile()) return Effect.succeed(0);
              return read(() => lstat(path)).pipe(
                Effect.map((stats) => stats.size),
                Effect.orElseSucceed(() => 0),
              );
            },
            { concurrency: FOLDER_CONCURRENCY },
          ),
        ),
        Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0)),
      );
    return walk(folder).pipe(Effect.orElseSucceed((): number | null => null));
  });

// Settings › Your data › Memory (ADR 028). A changed model is stored first, then the engine is
// reconfigured, which restarts only its process. A hub without an engine reports none.
export const MemoryHandlers = HttpApiBuilder.group(HobbotsApi, "memory", (handlers) =>
  Effect.gen(function* () {
    // A hub built without a data folder, as in tests, keeps the settings only while it runs.
    const kept = yield* Ref.make<MemorySettings>(DEFAULT_MEMORY_SETTINGS);
    const store = Option.getOrElse(yield* Effect.serviceOption(MemorySettingsStore), () => ({
      get: Ref.get(kept),
      set: (settings: MemorySettings) => Ref.set(kept, settings),
      bytes: Effect.succeed(null),
    }));
    const engine = Option.getOrUndefined(yield* Effect.serviceOption(MemoryEngine));
    const endpoint = Option.getOrUndefined(yield* Effect.serviceOption(MemoryModelEndpoint));
    const adapters = yield* runtimeAdapters;

    const overview = Effect.gen(function* () {
      const settings = yield* store.get;
      const status = engine === undefined ? null : yield* engine.status;
      return {
        settings,
        state: yield* memoryModelState(settings, adapters, endpoint),
        engine: engine === undefined ? null : yield* engine.health,
        pages: status?.pages ?? null,
        bytes: yield* store.bytes,
        usage: status?.usage ?? null,
      } satisfies MemoryOverview;
    });

    return handlers.handleAll({
      overview: () => overview,
      settings: ({ payload }) =>
        Effect.gen(function* () {
          yield* store.set(payload);
          if (engine !== undefined) yield* engine.reconfigure(engineSettingsFor(payload));
          return yield* overview;
        }),
    });
  }),
);
