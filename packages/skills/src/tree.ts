/**
 * What import reads a source as: a listing of its entries, and their bytes on demand. A folder, an
 * archive and a Git commit each give one, so the checks never know where a skill came from.
 */

/** One entry of a source, with `/` between folders and no leading slash. */
export interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly executable: boolean;
  /** In bytes, for a file; 0 otherwise. */
  readonly size: number;
}

export interface SkillTree {
  readonly entries: ReadonlyArray<TreeEntry>;
  /** The bytes of a file in `entries`. */
  readonly read: (path: string) => Promise<Uint8Array>;
  /** The commit a Git source was read at; null for any other source. */
  readonly commit: string | null;
}

/** The most entries import lists in one source, so a folder such as a home folder is refused, not walked. */
export const TREE_ENTRIES_MAX = 20_000;

/** Folders import never lists: they hold no skill and can be large. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** A source import could not read, with a message for you. */
export class TreeUnreadable extends Error {
  override readonly name = "TreeUnreadable";
}

/** The folder that holds `path`, or "" at the top. */
export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

/** `path` relative to `folder`, or null when it is not inside it. */
export const insideOf = (folder: string, path: string): string | null => {
  if (folder === "") return path;
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : null;
};
