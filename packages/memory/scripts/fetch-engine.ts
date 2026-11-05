/**
 * Fetches the pinned ai-memory release for one platform into an engine folder (ADR 028): downloads
 * its archive, checks it against the SHA-256 pinned in src/engine/release.ts, extracts only the
 * binary and its license, and writes the binary's own checksum beside it, which the hub checks
 * before every start.
 *
 *   pnpm --filter @hobbots/memory fetch-engine [--target darwin-arm64] [--out <folder>]
 *
 * The target defaults to this machine's, and the folder to engine/<target> in this package.
 * A folder that already holds the pinned version is left as it is.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkoutEngineFolder,
  checksumLine,
  ENGINE_BINARY,
  ENGINE_CHECKSUM,
  parseChecksum,
  sha256File,
} from "../src/engine/binary.ts";
import {
  AI_MEMORY_ARCHIVES,
  AI_MEMORY_VERSION,
  type EngineTarget,
  engineTarget,
  releaseUrl,
} from "../src/engine/release.ts";

/** The only archive members taken out: the binary and its license. */
const MEMBERS = [`./${ENGINE_BINARY}`, "./LICENSE"];
const VERSION_FILE = "VERSION";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const run = (command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

/** Whether `folder` already holds the pinned version, its binary matching the checksum beside it. */
const isCurrent = async (folder: string) => {
  try {
    if (readFileSync(join(folder, VERSION_FILE), "utf8").trim() !== AI_MEMORY_VERSION) return false;
    const want = parseChecksum(readFileSync(join(folder, ENGINE_CHECKSUM), "utf8"));
    return want !== undefined && want === (await sha256File(join(folder, ENGINE_BINARY)));
  } catch {
    return false;
  }
};

export const fetchEngine = async (target: EngineTarget, folder: string) => {
  if (await isCurrent(folder)) {
    console.log(`ai-memory ${AI_MEMORY_VERSION} (${target}) is already in ${folder}`);
    return;
  }
  const archive = AI_MEMORY_ARCHIVES[target];
  const url = releaseUrl(archive.asset);
  console.log(`Fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) fail(`Could not download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== archive.sha256) fail(`${archive.asset} has SHA-256 ${sha256}, but ${archive.sha256} is pinned`);

  const work = mkdtempSync(join(tmpdir(), "hobbots-ai-memory-"));
  try {
    const file = join(work, archive.asset);
    writeFileSync(file, bytes);
    // Only the named members come out, so nothing in the archive can write outside `work`.
    const listed = run("tar", ["-tzf", file]).split("\n");
    for (const member of MEMBERS) if (!listed.includes(member)) fail(`${archive.asset} holds no ${member}`);
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    run("tar", ["--no-same-owner", "-xzf", file, "-C", unpacked, ...MEMBERS]);

    const staged = join(work, "engine");
    mkdirSync(staged);
    renameSync(join(unpacked, ENGINE_BINARY), join(staged, ENGINE_BINARY));
    renameSync(join(unpacked, "LICENSE"), join(staged, "LICENSE"));
    chmodSync(join(staged, ENGINE_BINARY), 0o755);
    writeFileSync(join(staged, ENGINE_CHECKSUM), checksumLine(await sha256File(join(staged, ENGINE_BINARY))));
    writeFileSync(join(staged, VERSION_FILE), `${AI_MEMORY_VERSION}\n`);

    rmSync(folder, { recursive: true, force: true });
    mkdirSync(resolve(folder, ".."), { recursive: true });
    renameSync(staged, folder);
    console.log(`ai-memory ${AI_MEMORY_VERSION} (${target}) is in ${folder}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const { values } = parseArgs({ options: { target: { type: "string" }, out: { type: "string" } } });
  const target = engineTarget(...((values.target?.split("-") ?? [process.platform, process.arch]) as [string, string]));
  if (target === undefined)
    fail(`Hobbots bundles no memory engine for ${values.target ?? `${process.platform}-${process.arch}`}`);
  const chosen = target as EngineTarget;
  const folder = values.out === undefined ? checkoutEngineFolder(chosen) : resolve(values.out);
  if (existsSync(folder) && !(await isCurrent(folder))) console.log(`Replacing the engine in ${folder}`);
  await fetchEngine(chosen, folder);
}
