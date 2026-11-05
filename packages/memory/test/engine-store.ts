import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { MemoryStore } from "@hobbots/agents";
import { Context, Effect, Exit, Layer, Option, Schedule, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterAll } from "vitest";
import { defaultEngineFolder, ENGINE_BINARY } from "../src/engine/binary.ts";
import { MemoryEngine } from "../src/engine/engine.ts";
import { loadOrCreateMemoryKeys, type MemoryKeys } from "../src/engine/keys.ts";
import { MemoryStoreAiMemory } from "../src/store/ai-memory.ts";

// The bundled ai-memory for tests (ADR 028), as the engine's contract tests run it: skipped without
// the engine, and failed for its absence in CI (HOBBOTS_MEMORY_CONTRACT=1).
const folder = process.env.HOBBOTS_MEMORY_ENGINE_DIR ?? defaultEngineFolder();
const fetched = folder !== undefined && existsSync(join(folder, ENGINE_BINARY));
export const engineEnabled = fetched || process.env.HOBBOTS_MEMORY_CONTRACT === "1";

const scopes: Array<Scope.Closeable> = [];
const dataDirs: Array<string> = [];

afterAll(async () => {
  for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
}, 60_000);

/**
 * Starts the engine on `dataDir`, as the hub does, and answers its MemoryStore, the scope it runs in
 * (closing it stops the engine) and its endpoint.
 */
export const startEngineStore = (dataDir: string, keys: MemoryKeys) =>
  Effect.gen(function* () {
    if (!fetched) return yield* Effect.die(new Error(`No ai-memory engine in ${folder}; run fetch-engine`));
    const scope = yield* Scope.make();
    scopes.push(scope);
    const engine = MemoryEngine.layer({ folder: folder ?? "", dataDir, keys });
    const layer = MemoryStoreAiMemory.pipe(
      Layer.provideMerge(engine),
      Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    );
    const context = yield* Layer.buildWithScope(layer, scope);
    yield* Context.get(context, MemoryEngine).health.pipe(
      Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (health) => health.state !== "starting" }),
      Effect.timeout("60 seconds"),
    );
    const endpoint = yield* Context.get(context, MemoryEngine).endpoint;
    if (Option.isNone(endpoint)) return yield* Effect.die(new Error("The memory engine did not start"));
    return { store: Context.get(context, MemoryStore), scope, endpoint: endpoint.value };
  }).pipe(Effect.orDie);

/** A new data folder with its keys, cleaned up after the tests. */
export const engineDataDir = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hobbots-memory-store-"));
  dataDirs.push(dataDir);
  return { dataDir, keys: loadOrCreateMemoryKeys(dataDir) };
};
