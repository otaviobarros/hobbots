import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { FolderScanner, type ScannedFolder } from "@hobbots/agents";
import type { ActivityLimits, ScannedFile, ScanStop } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import ignore, { type Ignore } from "ignore";

/**
 * Lists a hob's folders for the Workbench's changes (ADR 023). It reads the files themselves: no
 * Git command, hook or tool from the folder ever runs, since Git can run code a repository's own
 * config names. Links are recorded as links and never followed.
 */

/** Folders no scan enters: Git's own data and installed packages. */
const SKIPPED = new Set([".git", "node_modules"]);

/**
 * How long a file must have been left alone before a scan starts for its hash to be reused. File
 * systems stamp a change with a clock coarser than the scan's, so a change made just after a scan
 * began can carry an earlier change time; this covers that tick, and one-second file systems too.
 */
const SETTLE_NS = 2_000_000_000n;

/** What an earlier scan hashed, and when that scan began, to reuse the hash while the file provably did not change. */
interface Seen {
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly hash: string;
  readonly scanStartNs: bigint;
}

/**
 * Whether `stats` is the file an earlier scan hashed, unchanged: the same inode, size, modification
 * and change time to the nanosecond, and a change time well before that scan began. Any process can
 * put a modification time back, but none without root can set the change time, which every write
 * and every attempt to restore the modification time moves.
 */
const unchangedSince = (seen: Seen | undefined, stats: BigIntStats): seen is Seen =>
  seen !== undefined &&
  seen.ino === stats.ino &&
  seen.size === stats.size &&
  seen.mtimeNs === stats.mtimeNs &&
  seen.ctimeNs === stats.ctimeNs &&
  stats.ctimeNs + SETTLE_NS < seen.scanStartNs;

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Whether `full` sits in `root` (canonical) through real folders only, as the path resolves now. */
const insideRoot = async (root: string, full: string) => {
  const parent = await realpath(dirname(full)).catch(() => null);
  return parent !== null && (parent === root || parent.startsWith(`${root}${sep}`));
};

/** macOS's `O_NOFOLLOW_ANY`: the open fails if any part of the path is a link. Node does not name it. */
const O_NOFOLLOW_ANY = 0x20000000;

/**
 * Opens `full`, a path in the canonical folder `root`, without passing through a link anywhere on
 * the way, as one step: a folder a command swaps for a link while the hub opens a file is never
 * passed through. On macOS the kernel refuses any link on the path (`O_NOFOLLOW_ANY`). On Linux the
 * open refuses a link at the name, and the kernel's own record of what the descriptor opened must
 * be `full` itself. Elsewhere, the path must still resolve inside `root` after the open, which a
 * swap timed between the two can get past.
 */
const openPath = async (root: string, full: string): Promise<FileHandle | null> => {
  const base = constants.O_RDONLY | constants.O_NONBLOCK;
  if (process.platform === "darwin") return open(full, base | O_NOFOLLOW_ANY).catch(() => null);
  const handle = await open(full, base | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) return null;
  const opened =
    process.platform === "linux"
      ? (await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null)) === full
      : await insideRoot(root, full);
  if (opened) return handle;
  await handle.close();
  return null;
};

/** A regular file inside `root`, opened for reading through no link, or null. Every read goes through it. */
const openInside = async (root: string, full: string): Promise<FileHandle | null> => {
  const handle = await openPath(root, full);
  if (handle === null) return null;
  if ((await handle.stat().catch(() => null))?.isFile() === true) return handle;
  await handle.close();
  return null;
};

/** The SHA-256 of a regular file's contents inside `root`, or null. */
const hashFile = async (root: string, path: string): Promise<string | null> => {
  const handle = await openInside(root, path);
  if (handle === null) return null;
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Uint8Array);
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

/** A `.gitignore`'s rules and the folder they apply under, `/`-separated and ending with `/`, or empty at the top. */
interface Rules {
  readonly base: string;
  readonly ignore: Ignore;
}

/** Whether `path` (with `/` at the end for a folder) is ignored by the rules that apply to it, deepest last. */
const ignoredBy = (rules: ReadonlyArray<Rules>, path: string) => {
  let ignored = false;
  for (const rule of rules) {
    if (!path.startsWith(rule.base)) continue;
    const verdict = rule.ignore.test(path.slice(rule.base.length));
    if (verdict.ignored) ignored = true;
    else if (verdict.unignored) ignored = false;
  }
  return ignored;
};

/** A `.gitignore` read as data, or none when there is no regular file by that name. */
const readRules = async (root: string, base: string, file: string): Promise<Rules | null> => {
  const path = join(root, ...base.split("/").filter(Boolean), file);
  const handle = await openInside(root, path);
  if (handle === null) return null;
  try {
    return { base, ignore: ignore().add(await handle.readFile("utf8")) };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

/** Whether the folder is in a Git repository: it or a folder above it has `.git`. */
const inGit = async (folder: string) => {
  for (let at = folder; ; at = dirname(at)) {
    if (
      await lstat(join(at, ".git")).then(
        () => true,
        () => false,
      )
    )
      return true;
    if (dirname(at) === at) return false;
  }
};

class Stopped extends Error {
  constructor(readonly reason: ScanStop) {
    super(reason);
  }
}

interface Walk {
  readonly folder: string;
  readonly limits: Pick<ActivityLimits, "maxFiles" | "scanTimeoutMs">;
  readonly git: boolean;
  readonly deadline: number;
  readonly startNs: bigint;
  readonly listing: Map<string, ScannedFile>;
  readonly seen: Map<string, Seen>;
  readonly next: Map<string, Seen>;
}

/** Records one entry of a folder: a file with its hash, a link with its target's, or nothing else. */
const visit = async (walk: Walk, path: string, full: string) => {
  const stats = await lstat(full, { bigint: true }).catch(() => null);
  if (stats === null) return;
  if (walk.listing.size >= walk.limits.maxFiles) throw new Stopped("too-many-files");
  if (stats.isSymbolicLink()) {
    const target = await readlink(full).catch(() => null);
    if (target !== null && (await insideRoot(walk.folder, full)))
      walk.listing.set(path, { kind: "link", size: Buffer.byteLength(target), hash: sha256(target) });
    return;
  }
  if (!stats.isFile()) return;
  const before = walk.seen.get(path);
  const hash = unchangedSince(before, stats) ? before.hash : await hashFile(walk.folder, full);
  if (hash === null) return;
  walk.listing.set(path, { kind: "file", size: Number(stats.size), hash });
  walk.next.set(path, {
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    hash,
    scanStartNs: walk.startNs,
  });
};

/** Every entry of one folder, by `/`-separated path, with what `.gitignore` files skip left out. */
const entriesOf = async (walk: Walk, base: string, rules: ReadonlyArray<Rules>) => {
  const directory = await opendir(join(walk.folder, ...base.split("/").filter(Boolean))).catch(() => null);
  if (directory === null) return { entries: [] as Array<Dirent>, rules };
  const entries: Array<Dirent> = [];
  for await (const entry of directory) entries.push(entry);
  // A folder swapped for a link lists nothing: what it holds is outside. Each entry is checked again as it is read.
  const listed = join(walk.folder, ...base.split("/").filter(Boolean), "entry");
  if (base !== "" && !(await insideRoot(walk.folder, listed))) return { entries: [], rules };
  const own = walk.git && entries.some((entry) => entry.name === ".gitignore" && entry.isFile());
  const added = own ? await readRules(walk.folder, base, ".gitignore") : null;
  return { entries, rules: added === null ? rules : [...rules, added] };
};

const walkFolder = async (walk: Walk, top: ReadonlyArray<Rules>) => {
  const pending: Array<{ readonly base: string; readonly rules: ReadonlyArray<Rules> }> = [{ base: "", rules: top }];
  while (pending.length > 0) {
    const { base, rules: above } = pending.pop() as { readonly base: string; readonly rules: ReadonlyArray<Rules> };
    if (Date.now() > walk.deadline) throw new Stopped("too-slow");
    const { entries, rules } = await entriesOf(walk, base, above);
    for (const entry of entries) {
      const path = `${base}${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && !ignoredBy(rules, `${path}/`)) pending.push({ base: `${path}/`, rules });
        continue;
      }
      if (ignoredBy(rules, path)) continue;
      await visit(walk, path, join(walk.folder, ...path.split("/")));
      if (Date.now() > walk.deadline) throw new Stopped("too-slow");
    }
  }
};

/** The scanner, remembering each file's hash from one scan to the next so unchanged files are not read again. */
export const makeFolderScanner = () => {
  const remembered = new Map<string, Map<string, Seen>>();

  const scan = async (
    folder: string,
    limits: Pick<ActivityLimits, "maxFiles" | "scanTimeoutMs">,
  ): Promise<ScannedFolder> => {
    const startNs = BigInt(Date.now()) * 1_000_000n;
    const stats = await lstat(folder).catch(() => null);
    const root = await realpath(folder).catch(() => null);
    if (stats === null || !stats.isDirectory() || root !== folder)
      return { listing: new Map(), filesScanned: 0, stopped: "unreadable" };
    const git = await inGit(folder);
    const walk: Walk = {
      folder,
      limits,
      git,
      deadline: Date.now() + limits.scanTimeoutMs,
      startNs,
      listing: new Map(),
      seen: remembered.get(folder) ?? new Map(),
      next: new Map(),
    };
    const exclude = git ? await readRules(folder, "", join(".git", "info", "exclude")) : null;
    try {
      await walkFolder(walk, exclude === null ? [] : [exclude]);
    } catch (error) {
      if (error instanceof Stopped)
        return { listing: new Map(), filesScanned: walk.listing.size, stopped: error.reason };
      throw error;
    }
    remembered.set(folder, walk.next);
    return { listing: walk.listing, filesScanned: walk.listing.size, stopped: null };
  };

  /** The first `maxBytes` of a regular file inside `folder`, reached through no link. */
  const read = async (folder: string, path: string, maxBytes: number): Promise<Uint8Array | null> => {
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
    const root = await realpath(folder);
    const handle = await openInside(root, join(root, ...parts));
    if (handle === null) return null;
    try {
      const buffer = new Uint8Array(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };

  return FolderScanner.of({
    scan: (folder, limits) =>
      Effect.tryPromise(() => scan(folder, limits)).pipe(
        Effect.catch(() =>
          Effect.succeed<ScannedFolder>({ listing: new Map(), filesScanned: 0, stopped: "unreadable" }),
        ),
      ),
    read: (folder, path, maxBytes) =>
      Effect.tryPromise(() => read(folder, path, maxBytes)).pipe(
        Effect.map(Option.fromNullishOr),
        Effect.orElseSucceed(() => Option.none()),
      ),
  });
};

/** The hub's folder scanner. */
export const FolderScannerLive = Layer.sync(FolderScanner, makeFolderScanner);
