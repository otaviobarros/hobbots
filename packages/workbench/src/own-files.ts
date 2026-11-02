import { lstat } from "node:fs/promises";

/**
 * Whether an open file can be one the hub wrote: a regular file with one name, owned by the hub's
 * user. A link, a device, a second name or a file another user planted is never read or written.
 */
export const ownFile = (stats: { isFile(): boolean; nlink: number; uid: number }) =>
  stats.isFile() && stats.nlink === 1 && (process.getuid === undefined || stats.uid === process.getuid());

/** Whether `folder` is the folder itself, never a link to somewhere else. */
export const realFolder = async (folder: string) => {
  const stats = await lstat(folder).catch(() => null);
  return stats?.isDirectory() === true && !stats.isSymbolicLink();
};
