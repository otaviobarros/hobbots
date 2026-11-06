import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SKIPPED_FOLDERS, type SkillTree, TREE_ENTRIES_MAX, type TreeEntry, TreeUnreadable } from "../tree.ts";

const kindOf = (stats: Awaited<ReturnType<typeof lstat>>): TreeEntry["kind"] => {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  return stats.isFile() ? "file" : "other";
};

/**
 * Lists `root` without following any link: a link is listed as one, for the checks to refuse, and
 * never read. `.git` and `node_modules` are left out.
 */
const walk = async (root: string): Promise<ReadonlyArray<TreeEntry>> => {
  const entries: Array<TreeEntry> = [];
  const pending: Array<string> = [""];
  while (pending.length > 0) {
    const folder = pending.pop() ?? "";
    const names = (await readdir(join(root, folder))).sort();
    for (const name of names) {
      const path = folder === "" ? name : `${folder}/${name}`;
      const stats = await lstat(join(root, path));
      const kind = kindOf(stats);
      if (kind === "directory" && SKIPPED_FOLDERS.has(name)) continue;
      entries.push({ path, kind, executable: kind === "file" && (stats.mode & 0o111) !== 0, size: Number(stats.size) });
      if (entries.length > TREE_ENTRIES_MAX) {
        throw new TreeUnreadable(`The folder holds more than ${TREE_ENTRIES_MAX} files; pick the folder of the skill.`);
      }
      if (kind === "directory") pending.push(path);
    }
  }
  return entries;
};

/** A folder on the hub's computer, read in place; import copies what it takes. */
export const folderTree = async (root: string): Promise<SkillTree> => {
  const stats = await lstat(root).catch(() => null);
  if (stats === null || !stats.isDirectory()) throw new TreeUnreadable(`${root} is not a folder.`);
  const entries = await walk(root);
  const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
  return {
    entries,
    commit: null,
    read: async (path) => {
      if (!files.has(path)) throw new TreeUnreadable(`${path} is not a file of the folder.`);
      // Read again without following a link, in case the file was swapped for one since the listing.
      if ((await lstat(join(root, path))).isSymbolicLink()) throw new TreeUnreadable(`${path} became a link.`);
      return readFile(join(root, path));
    },
  };
};
