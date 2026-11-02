import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** macOS's `O_NOFOLLOW_ANY`: an open fails if any part of the path is a link. Node does not name it. */
const O_NOFOLLOW_ANY = 0x20000000;

const READ_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY;
const WRITE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;

const tryOpen = (path: string, flags: number, mode?: number): number | undefined => {
  try {
    return openSync(path, flags, mode);
  } catch {
    return undefined;
  }
};

/**
 * On Linux every step is taken from an open folder, not from a path: `/proc/self/fd/<n>/<name>`
 * names an entry of the folder the descriptor holds, so a folder another process swaps for a link
 * after it was opened is never passed through. Each level is opened refusing a link at its name.
 */
const onLinux = (folder: string, levels: ReadonlyArray<string>, name: string, content: string | null) => {
  let at = tryOpen(folder, READ_DIRECTORY | constants.O_NOFOLLOW);
  if (at === undefined) return;
  try {
    if (readlinkSync(`/proc/self/fd/${at}`) !== folder) return;
    for (const level of levels) {
      const entry = `/proc/self/fd/${at}/${level}`;
      if (lstatSync(entry, { throwIfNoEntry: false }) === undefined) mkdirSync(entry);
      const next = tryOpen(entry, READ_DIRECTORY | constants.O_NOFOLLOW);
      if (next === undefined) return;
      closeSync(at);
      at = next;
    }
    const entry = `/proc/self/fd/${at}/${name}`;
    if (content === null) {
      // Removes the file or link itself, never what a link points to, and never a folder.
      if (lstatSync(entry, { throwIfNoEntry: false })?.isDirectory() === false) unlinkSync(entry);
      return;
    }
    const file = tryOpen(entry, WRITE_FILE | constants.O_NOFOLLOW, 0o644);
    if (file === undefined) return;
    try {
      if (fstatSync(file).isFile()) writeFileSync(file, content);
    } finally {
      closeSync(file);
    }
  } finally {
    closeSync(at);
  }
};

/**
 * On macOS the kernel refuses any link on the path (`O_NOFOLLOW_ANY`) for each folder checked and
 * for the file written, so a write never lands outside. Making a missing folder and removing a
 * file go by path after that check: a swap timed between the two can redirect those, never a write.
 */
const onMac = (folder: string, levels: ReadonlyArray<string>, name: string, content: string | null) => {
  let at = folder;
  for (const level of levels) {
    at = join(at, level);
    if (lstatSync(at, { throwIfNoEntry: false }) === undefined) mkdirSync(at);
    const checked = tryOpen(at, READ_DIRECTORY | O_NOFOLLOW_ANY);
    if (checked === undefined) return;
    closeSync(checked);
  }
  const target = join(at, name);
  if (content === null) {
    if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === false) unlinkSync(target);
    return;
  }
  const file = tryOpen(target, WRITE_FILE | O_NOFOLLOW_ANY, 0o644);
  if (file === undefined) return;
  try {
    if (fstatSync(file).isFile()) writeFileSync(file, content);
  } finally {
    closeSync(file);
  }
};

/**
 * Makes a scripted call's writes inside the hob's first folder, `folder` (canonical): text to write,
 * or null to remove the file. A path that leaves the folder, or that passes through a link anywhere,
 * is not written: the fake never reaches past what the hob was given. Only Linux and macOS write.
 */
export const applyScriptedWrites = (writes: Readonly<Record<string, string | null>>, folder: string) => {
  if (!isAbsolute(folder) || normalize(folder) !== folder) return;
  const write = process.platform === "linux" ? onLinux : process.platform === "darwin" ? onMac : null;
  if (write === null) return;
  for (const [path, content] of Object.entries(writes)) {
    const target = resolve(folder, path);
    if (!target.startsWith(`${folder}${sep}`)) continue;
    const parts = relative(folder, target).split(sep);
    const name = parts.pop();
    if (name === undefined) continue;
    try {
      write(folder, parts, name, content);
    } catch {
      // A write the file system refuses is skipped, as a command's failed write would be.
    }
  }
};
