import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Redacted } from "effect";
import { create, list, type ReadEntry, extract as untar } from "tar";
import { configHoldsCredential } from "./config.ts";
import type { MemoryKeys } from "./keys.ts";

/**
 * Memory in a backup (ADR 028): the archive ai-memory's own backup makes while it runs, kept as it
 * is under `memory/` in a Hobbots backup. It holds the wiki with its Git history, a consistent copy
 * of the engine's SQLite database and the config the hub wrote, and nothing else: the bearers reach
 * the engine only in its environment, so they are never in it, and `checkMemoryArchive` proves it.
 */

/** The archive's name inside a backup's `memory/` folder. */
export const MEMORY_ARCHIVE = "ai-memory.tar.gz";

/** What ai-memory's backup holds: its wiki, its database and its config, at the archive's root. */
const ROOTS: ReadonlySet<string> = new Set(["wiki", "db", "config.toml"]);

/** The most an archive may grow when unpacked, against what it takes compressed. */
const MAX_RATIO = 1000;

/** Why a memory archive cannot go into a backup, or be restored. */
export class MemoryArchiveRefused extends Data.TaggedError("MemoryArchiveRefused")<{ readonly reason: string }> {}

const rootOf = (path: string) => path.replace(/^\.\//, "").split("/")[0] ?? "";

/** An entry Hobbots unpacks: a file or folder under one of the roots, and never a link or a device. */
const allowed = (entry: Pick<ReadEntry, "path" | "type">) =>
  (entry.type === "File" || entry.type === "OldFile" || entry.type === "Directory") && ROOTS.has(rootOf(entry.path));

/**
 * Finds any of `needles` in a stream of chunks, across chunk boundaries: each chunk is searched with
 * the end of the one before it.
 */
const searcher = (needles: ReadonlyArray<string>) => {
  const overlap = Math.max(0, ...needles.map((needle) => needle.length - 1));
  let tail = "";
  let found = false;
  return {
    push: (chunk: Buffer) => {
      if (found || needles.length === 0) return;
      const text = tail + chunk.toString("latin1");
      found = needles.some((needle) => text.includes(needle));
      tail = text.slice(Math.max(0, text.length - overlap));
    },
    get found() {
      return found;
    },
  };
};

/**
 * Reads a memory archive through without unpacking it, and refuses it unless every entry is a file
 * or folder under the wiki, the database or the config, and when a config in it holds a credential
 * setting. With `keys`, it is also refused when either bearer appears anywhere in it: a backup never
 * holds a memory bearer (ADR 028).
 */
export const checkMemoryArchive = (file: string, keys?: MemoryKeys) =>
  Effect.tryPromise({
    try: async () => {
      const bearers = keys === undefined ? [] : [Redacted.value(keys.root), Redacted.value(keys.proxy)];
      const problems: Array<string> = [];
      const configs: Array<{ readonly path: string; readonly chunks: Array<Buffer> }> = [];
      let entries = 0;
      await list({
        file,
        strict: true,
        maxDecompressionRatio: MAX_RATIO,
        onReadEntry: (entry) => {
          entries++;
          if (!allowed(entry)) {
            problems.push(`it holds ${entry.path}, which is not part of a memory backup`);
            return;
          }
          const search = searcher(bearers);
          const config = entry.path.endsWith(".toml") ? { path: entry.path, chunks: [] as Array<Buffer> } : undefined;
          if (config !== undefined) configs.push(config);
          entry.on("data", (chunk: Buffer) => {
            search.push(chunk);
            config?.chunks.push(chunk);
          });
          entry.on("end", () => {
            if (search.found) problems.push(`${entry.path} holds a memory bearer`);
          });
        },
      });
      if (entries === 0) problems.push("it is empty");
      // A credential setting is refused whatever its value, so with no keys to match too.
      for (const config of configs) {
        if (configHoldsCredential(Buffer.concat(config.chunks).toString("utf8"), keys)) {
          problems.push(`${config.path} holds a credential`);
        }
      }
      if (problems.length > 0) throw new MemoryArchiveRefused({ reason: problems.join("; ") });
    },
    catch: (cause) =>
      cause instanceof MemoryArchiveRefused
        ? cause
        : new MemoryArchiveRefused({ reason: `it could not be read: ${String(cause)}` }),
  });

/**
 * Packs the memory of an engine that is not running, as ai-memory's own backup would: its wiki and
 * database folders and its config, regular files only, into a new owner-only archive at `target`,
 * then checks it as `checkMemoryArchive` does. With nothing running there, the files are already
 * consistent. Answers false, writing nothing, when the engine never kept anything there.
 */
export const packStoppedMemory = (memoryDir: string, target: string, keys?: MemoryKeys) =>
  Effect.gen(function* () {
    const roots = [...ROOTS].filter((root) => existsSync(join(memoryDir, root)));
    if (!roots.includes("wiki")) return false;
    yield* Effect.tryPromise({
      try: () =>
        create(
          {
            file: target,
            cwd: memoryDir,
            gzip: true,
            portable: true,
            strict: true,
            mode: 0o600,
            filter: (_path, stat) => ("isFile" in stat ? stat.isFile() || stat.isDirectory() : true),
          },
          roots,
        ),
      catch: (cause) => new MemoryArchiveRefused({ reason: `memory could not be packed: ${String(cause)}` }),
    });
    yield* checkMemoryArchive(target, keys);
    return true;
  }).pipe(Effect.tapError(() => Effect.promise(() => rm(target, { force: true }))));

/**
 * Unpacks a checked memory archive into the engine's data folder `memoryDir`, owner-only, with no
 * engine running there: the engine's next start opens the restored wiki and database. The config
 * comes back too, and the hub writes its own over it before that start. Links, devices and anything
 * outside the archive's roots are refused by the check and never unpacked.
 */
export const restoreMemoryArchive = (file: string, memoryDir: string) =>
  Effect.gen(function* () {
    yield* checkMemoryArchive(file);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(memoryDir, { recursive: true, mode: 0o700 });
        await untar({
          file,
          cwd: memoryDir,
          strict: true,
          maxDecompressionRatio: MAX_RATIO,
          filter: (_path, entry) => "type" in entry && allowed(entry),
          // Owned by the hub's user and owner-only, whatever owners and modes the archive names.
          preserveOwner: false,
          onReadEntry: (entry) => {
            entry.mode = entry.type === "Directory" ? 0o700 : 0o600;
          },
        });
      },
      catch: (cause) => new MemoryArchiveRefused({ reason: `it could not be unpacked: ${String(cause)}` }),
    });
  });
