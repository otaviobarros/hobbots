import { execFileSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

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
 * The script a child process runs to make writes from inside the folder itself: it moves its own
 * working folder into the hob's folder one level at a time, checking after each step that the
 * kernel puts it where it should be, and then names every entry relative to that folder. Once the
 * child is in a folder, swapping that folder or any above it for a link changes nothing for it:
 * folders are made, files written and removed in the folder it holds, and a link at a name is
 * never followed. Run apart so the hub's own working folder never moves.
 */
const CHILD_SCRIPT = `
const fs = require("node:fs");
const { join } = require("node:path");
const [folder, operations] = JSON.parse(process.argv[1]);
const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
for (const { levels, name, content } of operations) {
  try {
    process.chdir(folder);
    if (process.cwd() !== folder) continue;
    let expected = folder;
    let inside = true;
    for (const level of levels) {
      if (fs.lstatSync(level, { throwIfNoEntry: false }) === undefined) fs.mkdirSync(level);
      process.chdir(level);
      expected = join(expected, level);
      if (process.cwd() !== expected) { inside = false; break; }
    }
    if (!inside) continue;
    if (content === null) {
      if (fs.lstatSync(name, { throwIfNoEntry: false })?.isDirectory() === false) fs.unlinkSync(name);
      continue;
    }
    const file = fs.openSync(name, flags, 0o644);
    try { if (fs.fstatSync(file).isFile()) fs.writeFileSync(file, content); } finally { fs.closeSync(file); }
  } catch {}
}
`;

interface Operation {
  readonly levels: ReadonlyArray<string>;
  readonly name: string;
  readonly content: string | null;
}

/** Makes `operations` in a child process working from inside `folder` (see `CHILD_SCRIPT`). */
const fromInside = (folder: string, operations: ReadonlyArray<Operation>) => {
  if (operations.length === 0) return;
  execFileSync(process.execPath, ["-e", CHILD_SCRIPT, JSON.stringify([folder, operations])], {
    cwd: tmpdir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
};

/** How the fake makes its writes: from open folders through `/proc` on Linux, from inside the folder elsewhere. */
type WriteStrategy = "descriptors" | "inside";

/**
 * Makes a scripted call's writes inside the hob's first folder, `folder` (canonical): text to write,
 * or null to remove the file. A path that leaves the folder, or that passes through a link anywhere,
 * is not written: the fake never reaches past what the hob was given. On Linux each step is taken
 * from an open folder; elsewhere a child process makes them from inside the folder itself.
 */
export const applyScriptedWrites = (
  writes: Readonly<Record<string, string | null>>,
  folder: string,
  strategy: WriteStrategy = process.platform === "linux" ? "descriptors" : "inside",
) => {
  if (!isAbsolute(folder) || normalize(folder) !== folder) return;
  const operations: Array<Operation> = [];
  for (const [path, content] of Object.entries(writes)) {
    const target = resolve(folder, path);
    if (!target.startsWith(`${folder}${sep}`)) continue;
    const levels = relative(folder, target).split(sep);
    const name = levels.pop();
    if (name !== undefined) operations.push({ levels, name, content });
  }
  if (strategy === "inside") {
    fromInside(folder, operations);
    return;
  }
  for (const { levels, name, content } of operations) {
    try {
      onLinux(folder, levels, name, content);
    } catch {
      // A write the file system refuses is skipped, as a command's failed write would be.
    }
  }
};
