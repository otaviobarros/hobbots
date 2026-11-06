/**
 * Puts the memory engine (ADR 028) into the packaged app. electron-builder copies the binary that
 * `fetch-engine` checked into the app's resources folder (`extraResources`); this `afterPack` hook
 * then checks it again and writes its SHA-256 beside it, which the hub checks before every start.
 * On macOS it first signs the binary with the app's own identity; electron-builder leaves it alone
 * after that (`signIgnore`), so the checksum stays true, and the app's seal covers both files.
 * Plain TypeScript with no enums, so Node runs it as it is.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AfterPackContext, Arch } from "electron-builder";

const ENGINE = "ai-memory";
const CHECKSUM = `${ENGINE}.sha256`;

/** Where `fetch-engine` put the checked engine for a platform and architecture, named as Node names them. */
const fetchedEngineFolder = (platform: string, arch: string) =>
  resolve(import.meta.dirname, "../../../packages/memory/engine", `${platform}-${arch}`);

/** The engine's place inside the app, for `extraResources`. */
export const ENGINE_RESOURCE = "memory";

/** Keeps electron-builder from signing the engine again after its checksum is written. */
export const MEMORY_ENGINE_SIGN_IGNORE = `/Contents/Resources/${ENGINE_RESOURCE}/${ENGINE}$`;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The digest a checksum file names. */
const named = (file: string) => /^([0-9a-f]{64})(?:\s|$)/.exec(readFileSync(file, "utf8").trim())?.[1];

/** The codesign arguments for the app's identity: ad hoc for now, hardened with a timestamp once it signs for real. */
const codesignArguments = (identity: string, hardenedRuntime: boolean, file: string) => [
  "--force",
  "--sign",
  identity,
  ...(hardenedRuntime ? ["--options", "runtime", "--timestamp"] : []),
  file,
];

/** The engine's folder inside the app electron-builder just packed. */
const packedEngineFolder = (context: AfterPackContext) =>
  context.electronPlatformName === "darwin"
    ? join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
        ENGINE_RESOURCE,
      )
    : join(context.appOutDir, "resources", ENGINE_RESOURCE);

export const prepareMemoryEngine = async (context: AfterPackContext) => {
  const platform = context.electronPlatformName;
  if (platform !== "darwin" && platform !== "linux") return;
  const arch = Arch[context.arch];
  const folder = packedEngineFolder(context);
  const binary = join(folder, ENGINE);
  // The copy in the app is the one fetch-engine checked against the pinned release.
  const fetched = named(join(fetchedEngineFolder(platform, arch), CHECKSUM));
  if (fetched === undefined || sha256(binary) !== fetched) {
    throw new Error(`The memory engine in ${folder} is not the one fetch-engine checked for ${platform}-${arch}`);
  }
  if (platform === "darwin") {
    const mac = context.packager.config.mac ?? {};
    const identity = typeof mac.identity === "string" ? mac.identity : "-";
    execFileSync("codesign", codesignArguments(identity, mac.hardenedRuntime === true, binary), { stdio: "inherit" });
  }
  writeFileSync(join(folder, CHECKSUM), `${sha256(binary)}  ${ENGINE}\n`);
  console.log(`Prepared the memory engine for ${platform}-${arch} and wrote its checksum`);
};
