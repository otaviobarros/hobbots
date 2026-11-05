import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HobbotsApi, type MemoryOverview } from "@hobbots/api";
import { DEFAULT_MEMORY_SETTINGS, type MemoryModelVendor, MemorySettings } from "@hobbots/domain";
import { engineSettingsFor, MemoryEngine } from "@hobbots/memory";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
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
 * The providers the hub can hand the memory engine a credential for. None yet: the engine refuses
 * to start with a provider it has no credential for, and the hub gives it no credential but its
 * own bearers (ADR 028), so memory runs with no AI until a provider's key can reach it (#972).
 */
export const memoryModelCanRun = (_provider: MemoryModelVendor): boolean => false;

interface MemorySettingsStoreShape {
  readonly get: Effect.Effect<MemorySettings>;
  readonly set: (settings: MemorySettings) => Effect.Effect<void>;
  /** The size of the memory folder on the hub in bytes, or null when there is none. */
  readonly bytes: Effect.Effect<number | null>;
}

export class MemorySettingsStore extends Context.Service<MemorySettingsStore, MemorySettingsStoreShape>()(
  "@hobbots/server/MemorySettingsStore",
) {
  /** The settings in the data folder, and the size of its `memory/` folder. */
  static readonly layer = (dataDir: string) =>
    Layer.succeed(MemorySettingsStore, {
      get: Effect.sync(() => readMemorySettings(dataDir)),
      set: (settings) => Effect.sync(() => writeMemorySettings(dataDir, settings)),
      bytes: Effect.sync(() => folderBytes(join(dataDir, "memory"))),
    });
}

/** The bytes of every file under `folder`, without following links; null when there is no folder. */
const folderBytes = (folder: string): number | null => {
  try {
    let total = 0;
    for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
    }
    return total;
  } catch {
    return null;
  }
};

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

    const overview = Effect.gen(function* () {
      const settings = yield* store.get;
      const status = engine === undefined ? null : yield* engine.status;
      return {
        settings,
        state: engineSettingsFor(settings, memoryModelCanRun).state,
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
          if (engine !== undefined) yield* engine.reconfigure(engineSettingsFor(payload, memoryModelCanRun).engine);
          return yield* overview;
        }),
    });
  }),
);
