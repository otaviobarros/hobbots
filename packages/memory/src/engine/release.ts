/**
 * The ai-memory release Hobbots bundles (ADR 028), pinned to an exact version and raised on purpose.
 * Each archive's SHA-256 is the one the release publishes beside it, copied here so a download is
 * checked against this file rather than against a checksum fetched with it. The contract tests in
 * `test/engine-contract.test.ts` run against this version.
 */
export const AI_MEMORY_VERSION = "3.4.2";

/** The platforms Hobbots bundles the engine for, named `<os>-<arch>` as Node names them. */
export type EngineTarget = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

export interface EngineArchive {
  readonly asset: string;
  readonly sha256: string;
}

export const AI_MEMORY_ARCHIVES: Readonly<Record<EngineTarget, EngineArchive>> = {
  "darwin-arm64": {
    asset: "ai-memory-macos-aarch64.tar.gz",
    sha256: "afefdfa7bac1dcbb9d4358f812825bba823470831a3e72ba804e9de5fada159b",
  },
  "darwin-x64": {
    asset: "ai-memory-macos-x86_64.tar.gz",
    sha256: "93f7c5d644e6de539e2ec9efb65c9596fda95b3f9470cab20645e4c7e673214a",
  },
  "linux-arm64": {
    asset: "ai-memory-linux-aarch64.tar.gz",
    sha256: "164f7c38bb9bafca218dd958c3c60febcd5d2f5200ad138c6f128576cedebfb6",
  },
  "linux-x64": {
    asset: "ai-memory-linux-x86_64.tar.gz",
    sha256: "15a4f4a346a27e6fd63a36d1b3de23c5cbe142b80b3bce561e21b1f225a1e645",
  },
};

/** Where a release's archives are downloaded from. */
export const releaseUrl = (asset: string) =>
  `https://github.com/akitaonrails/ai-memory/releases/download/v${AI_MEMORY_VERSION}/${asset}`;

/** The engine target for a Node platform and architecture, or undefined when Hobbots bundles none. */
export const engineTarget = (platform: string, arch: string): EngineTarget | undefined => {
  const target = `${platform}-${arch}`;
  return Object.hasOwn(AI_MEMORY_ARCHIVES, target) ? (target as EngineTarget) : undefined;
};
