import { constants } from "node:fs";
import { type FileHandle, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/** Whether `full` sits in `root` (canonical) through real folders only, as the path resolves now. */
export const resolvesInside = async (root: string, full: string): Promise<boolean> => {
  const parent = await realpath(dirname(full)).catch(() => null);
  return parent !== null && (parent === root || parent.startsWith(`${root}${sep}`));
};

/** macOS's `O_NOFOLLOW_ANY`: the open fails if any part of the path is a link. Node does not name it. */
const O_NOFOLLOW_ANY = 0x20000000;

/**
 * Opens `full`, a path in the canonical folder `root`, without passing through a link anywhere on
 * the way, as one step: a folder swapped for a link while the hub opens a file is never passed
 * through. On macOS the kernel refuses any link on the path (`O_NOFOLLOW_ANY`). On Linux the open
 * refuses a link at the name, and the kernel's own record of what the descriptor opened must be
 * `full` itself. Elsewhere, the path must still resolve inside `root` after the open, which a swap
 * timed between the two can get past.
 */
const openPath = async (root: string, full: string): Promise<FileHandle | null> => {
  const base = constants.O_RDONLY | constants.O_NONBLOCK;
  if (process.platform === "darwin") return open(full, base | O_NOFOLLOW_ANY).catch(() => null);
  const handle = await open(full, base | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) return null;
  const opened =
    process.platform === "linux"
      ? (await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null)) === full
      : await resolvesInside(root, full);
  if (opened) return handle;
  await handle.close();
  return null;
};

/** A regular file inside `root`, opened for reading through no link, or null. */
export const openInside = async (root: string, full: string): Promise<FileHandle | null> => {
  const handle = await openPath(root, full);
  if (handle === null) return null;
  if ((await handle.stat().catch(() => null))?.isFile() === true) return handle;
  await handle.close();
  return null;
};

/**
 * A regular file at `path` (`/`-separated, no `.` or `..`) inside `folder`, opened through no link,
 * or null. The folder is a canonical one, never resolved again: a folder swapped for a link since
 * is refused by the open, which allows no link on the path.
 */
export const openFileIn = async (folder: string, path: string): Promise<FileHandle | null> => {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (!isAbsolute(folder) || normalize(folder) !== folder) return null;
  return openInside(folder, join(folder, ...parts));
};
