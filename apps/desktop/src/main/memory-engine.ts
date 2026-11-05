import { join, resolve } from "node:path";

/**
 * Where the memory engine is (ADR 028): in the packaged app's resources folder, where packaging put
 * the build's architecture's copy, or in a checkout where `pnpm --filter @hobbots/memory
 * fetch-engine` put this machine's. The hub checks its checksum before it runs it.
 */
export const memoryEngineDir = (
  packaged: { readonly resourcesPath: string } | null,
  mainDir: string,
  platform: string = process.platform,
  arch: string = process.arch,
) =>
  packaged === null
    ? resolve(mainDir, "../../../../packages/memory/engine", `${platform}-${arch}`)
    : join(packaged.resourcesPath, "memory");
