/**
 * Takes write access away from everyone but the owner in a packed Linux app. Electron's Linux
 * archive stores its files with modes such as 0777 and 0666, and the .deb and .rpm keep the modes
 * they are given, so without this any local user could replace /opt/Hobbots/hobbots, which every
 * user then runs. Plain TypeScript with no enums, so Node runs it as it is.
 */
import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Removes group and other write from `folder` and everything below it; links are left alone. */
export const removeSharedWrite = async (folder: string) => {
  const paths = [folder, ...(await readdir(folder, { recursive: true })).map((path) => join(folder, path))];
  for (const path of paths) {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) continue;
    const mode = stats.mode & 0o7777;
    if ((mode & 0o022) !== 0) await chmod(path, mode & ~0o022);
  }
};
