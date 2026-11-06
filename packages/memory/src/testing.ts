import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultEngineFolder, ENGINE_BINARY } from "./engine/binary.ts";

export { MemorySavesFake, makeMemorySavesFake } from "./saves/fake.ts";
export { MemoryShareLogFake, makeMemoryShareLogFake } from "./shares/fake.ts";
export { MemoryStoreFake, type MemoryStoreFakeControls, makeMemoryStoreFake } from "./store/fake.ts";

/**
 * The bundled ai-memory that tests run against (ADR 028): `HOBBOTS_MEMORY_ENGINE_DIR`, or the folder
 * `fetch-engine` fills in a checkout. `enabled` runs the engine's tests when it was fetched, and in
 * CI (`HOBBOTS_MEMORY_CONTRACT=1`) also when it was not, so they fail for its absence instead of
 * being skipped.
 */
export const testEngine = (() => {
  const folder = process.env.HOBBOTS_MEMORY_ENGINE_DIR ?? defaultEngineFolder();
  const fetched = folder !== undefined && existsSync(join(folder, ENGINE_BINARY));
  return { folder, fetched, enabled: fetched || process.env.HOBBOTS_MEMORY_CONTRACT === "1" } as const;
})();
