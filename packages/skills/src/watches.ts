import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * One plain watch on each folder under `path`, never a recursive one: on Linux, Node's recursive
 * watch reads the tree itself on each event and throws, out of reach, when a folder in it is
 * replaced by a file. A plain watch only reports, and its errors arrive as its `error` event. Each
 * read re-arms the watches from what it listed; a folder replaced since gets a new one. A read
 * comes before the watches it lists, the first one included, so any new watch asks for one more
 * read, for a change made in between.
 */
export const folderWatches = (path: string, changed: () => void) => {
  const watches = new Map<string, { readonly watcher: FSWatcher; readonly ino: number }>();

  const drop = (folder: string) => {
    watches.get(folder)?.watcher.close();
    watches.delete(folder);
  };

  const arm = (folder: string, ino: number) => {
    try {
      const watcher = watch(join(path, folder), () => changed());
      // The folder went or changed under the watch: let it go, and read again to see what is there.
      watcher.on("error", () => {
        if (watches.get(folder)?.watcher === watcher) drop(folder);
        changed();
      });
      watches.set(folder, { watcher, ino });
      return true;
    } catch {
      // Gone since the read; the read it set off will see that.
      return false;
    }
  };

  /** Watches exactly `folders`, and asks for another read when any watch is new. */
  const rewatch = async (folders: ReadonlyArray<string>) => {
    const wanted = new Set(folders);
    for (const folder of [...watches.keys()]) if (!wanted.has(folder)) drop(folder);
    let added = false;
    for (const folder of folders) {
      const stats = await stat(join(path, folder)).catch(() => null);
      const known = watches.get(folder);
      if (stats === null || !stats.isDirectory()) {
        drop(folder);
        continue;
      }
      if (known?.ino === Number(stats.ino)) continue;
      drop(folder);
      added = arm(folder, Number(stats.ino)) || added;
    }
    if (added) changed();
  };

  const close = () => {
    for (const folder of [...watches.keys()]) drop(folder);
  };

  return { rewatch, close };
};
