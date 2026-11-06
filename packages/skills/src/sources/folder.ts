import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SKIPPED_FOLDERS, type SkillTree, TREE_ENTRIES_MAX, type TreeEntry, TreeUnreadable } from "../tree.ts";

type Stats = Awaited<ReturnType<typeof lstat>>;

/** Which filesystem object an entry was when it was listed. */
interface Identity {
  readonly dev: number;
  readonly ino: number;
}

const identityOf = (stats: Stats): Identity => ({ dev: Number(stats.dev), ino: Number(stats.ino) });
const sameObject = (stats: Stats, identity: Identity | undefined) =>
  identity !== undefined && Number(stats.dev) === identity.dev && Number(stats.ino) === identity.ino;

const kindOf = (stats: Stats): TreeEntry["kind"] => {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  return stats.isFile() ? "file" : "other";
};

const changed = (path: string) => new TreeUnreadable(`${path} changed while it was read; import it again.`);

/** Whether the folder at `path` is still the directory that was listed, and not a link put in its place. */
const stillFolder = async (root: string, path: string, identity: Identity | undefined) => {
  const stats = await lstat(join(root, path)).catch(() => null);
  return stats?.isDirectory() === true && sameObject(stats, identity);
};

interface Listing {
  readonly entries: ReadonlyArray<TreeEntry>;
  /** Every listed folder and file, "" for the top, by path. */
  readonly identities: ReadonlyMap<string, Identity>;
}

/**
 * Lists `root` without following any link: a link is listed as one, for the checks to refuse, and
 * never read. `.git` and `node_modules` are left out. Each folder is checked before and after it is
 * listed, so one swapped for a link while it is walked fails the listing.
 */
const walk = async (root: string): Promise<Listing> => {
  const entries: Array<TreeEntry> = [];
  const identities = new Map<string, Identity>([["", identityOf(await lstat(root))]]);
  const pending: Array<string> = [""];
  while (pending.length > 0) {
    const folder = pending.pop() ?? "";
    if (!(await stillFolder(root, folder, identities.get(folder)))) throw changed(folder || root);
    for (const name of (await readdir(join(root, folder))).sort()) {
      const path = folder === "" ? name : `${folder}/${name}`;
      const entry = await entryOf(root, path, name, identities);
      if (entry === null) continue;
      entries.push(entry);
      if (entries.length > TREE_ENTRIES_MAX) {
        throw new TreeUnreadable(`The folder holds more than ${TREE_ENTRIES_MAX} files; pick the folder of the skill.`);
      }
      if (entry.kind === "directory") pending.push(path);
    }
    if (!(await stillFolder(root, folder, identities.get(folder)))) throw changed(folder || root);
  }
  return { entries, identities };
};

/** One entry, without following a link, noted by identity when it is a folder or a file; null when left out. */
const entryOf = async (
  root: string,
  path: string,
  name: string,
  identities: Map<string, Identity>,
): Promise<TreeEntry | null> => {
  const stats = await lstat(join(root, path));
  const kind = kindOf(stats);
  if (kind === "directory" && SKIPPED_FOLDERS.has(name)) return null;
  if (kind === "directory" || kind === "file") identities.set(path, identityOf(stats));
  return { path, kind, executable: kind === "file" && (stats.mode & 0o111) !== 0, size: Number(stats.size) };
};

/** The folders from the top down to the one holding `path`: "" first. */
const ancestorsOf = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
};

/**
 * Where an open file really is, on a system that says (Linux, through `/proc`); null elsewhere. It
 * names the file the handle holds, so no link or swap along the way can make it read as inside.
 */
const realPathOf = (handle: FileHandle): Promise<string | null> =>
  readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);

/** No link is followed on open where the system offers it (not on Windows). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** A folder on the hub's computer, read in place; import copies what it takes. */
export const folderTree = async (root: string): Promise<SkillTree> => {
  const stats = await lstat(root).catch(() => null);
  if (stats === null || !stats.isDirectory()) throw new TreeUnreadable(`${root} is not a folder.`);
  const top = await realpath(root);
  const { entries, identities } = await walk(root);
  const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));

  /**
   * The file opened without following a link, and only when it is the very file that was listed and
   * still sits at its path inside the folder: a file or a folder above it swapped since the listing,
   * for a link or for anything else, is refused rather than read.
   */
  const verified = async (handle: FileHandle, path: string) => {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameObject(opened, identities.get(path))) throw changed(path);
    const real = await realPathOf(handle);
    if (real !== null && real !== join(top, path)) throw changed(path);
    for (const folder of ancestorsOf(path)) {
      if (!(await stillFolder(root, folder, identities.get(folder)))) throw changed(path);
    }
  };

  return {
    entries,
    commit: null,
    read: async (path) => {
      if (!files.has(path)) throw new TreeUnreadable(`${path} is not a file of the folder.`);
      const handle = await open(join(root, path), OPEN_FLAGS).catch(() => {
        throw changed(path);
      });
      try {
        await verified(handle, path);
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
  };
};
