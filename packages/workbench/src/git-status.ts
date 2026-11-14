import * as fs from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { GitWorkspace, type UncommittedFiles } from "@hobbots/agents";
import { Effect, Layer } from "effect";
import git from "isomorphic-git";

/**
 * Which files a Task left uncommitted in a Git repository (#586). Git itself never runs here: a
 * repository's own config can name hooks, filters and an fsmonitor that run code, so its files are
 * read with isomorphic-git instead, which runs none of them. The index is only read, never
 * refreshed.
 */

/**
 * A repository found above a file: its top folder, its Git folder and, for a linked worktree, the
 * main repository's Git folder that holds the refs and objects every worktree shares.
 */
interface Repository {
  readonly dir: string;
  readonly gitdir: string;
  readonly common: string | null;
}

/** The shared Git folder a linked worktree's `commondir` names, or null for a repository's own. */
const commonOf = async (gitdir: string): Promise<string | null> => {
  const named = (await readFile(join(gitdir, "commondir"), "utf8").catch(() => "")).trim();
  return named === "" ? null : isAbsolute(named) ? named : resolve(gitdir, named);
};

/**
 * What stays in a linked worktree's own Git folder, as Git keeps it: its HEAD, its index, the
 * other pseudo-refs and its own refs. The rest (objects, branches, tags, packed refs, config) is
 * shared, in the main repository's Git folder.
 */
const PER_WORKTREE = [/^[A-Z_]*HEAD$/, /^index$/, /^logs\/HEAD$/, /^refs\/(bisect|worktree|rewritten)(\/|$)/];

/**
 * The file system isomorphic-git reads a linked worktree through: one Git folder, as it expects,
 * with each shared file read from the main repository's. It reads only, since the index is never
 * refreshed.
 */
const worktreeFs = (gitdir: string, common: string) => {
  const route = (path: string) => {
    // isomorphic-git probes the file system with a call that names no file.
    if (typeof path !== "string") return path;
    const inside = relative(gitdir, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return path;
    const name = inside.split(sep).join("/");
    return PER_WORKTREE.some((pattern) => pattern.test(name)) ? path : join(common, inside);
  };
  const routed =
    <A extends ReadonlyArray<unknown>, R>(method: (path: string, ...rest: A) => R) =>
    async (path: string, ...rest: A) =>
      method(route(path), ...rest);
  const p = fs.promises;
  return {
    promises: {
      readFile: routed(p.readFile.bind(p) as (path: string, ...rest: Array<unknown>) => Promise<unknown>),
      readdir: routed(p.readdir.bind(p) as (path: string, ...rest: Array<unknown>) => Promise<unknown>),
      stat: routed(p.stat.bind(p) as (path: string, ...rest: Array<unknown>) => Promise<unknown>),
      lstat: routed(p.lstat.bind(p) as (path: string, ...rest: Array<unknown>) => Promise<unknown>),
      readlink: routed(p.readlink.bind(p) as (path: string, ...rest: Array<unknown>) => Promise<unknown>),
      // Nothing is written: a write would be a bug, so it fails.
      writeFile: () => Promise.reject(new Error("read-only")),
      mkdir: () => Promise.reject(new Error("read-only")),
      rmdir: () => Promise.reject(new Error("read-only")),
      unlink: () => Promise.reject(new Error("read-only")),
      symlink: () => Promise.reject(new Error("read-only")),
      chmod: () => Promise.reject(new Error("read-only")),
    },
  };
};

/**
 * The Git folder `.git` names in `dir`: the folder itself, or for a worktree or submodule, the
 * folder its `gitdir:` line points to. Null when there is none.
 */
const gitdirIn = async (dir: string): Promise<string | null> => {
  const dotGit = join(dir, ".git");
  const stats = await lstat(dotGit).catch(() => null);
  if (stats === null) return null;
  if (stats.isDirectory()) return dotGit;
  if (!stats.isFile()) return null;
  const line = (await readFile(dotGit, "utf8").catch(() => "")).split("\n")[0]?.trim() ?? "";
  if (!line.startsWith("gitdir:")) return null;
  const target = line.slice("gitdir:".length).trim();
  return target === "" ? null : isAbsolute(target) ? target : resolve(dir, target);
};

/** The nearest repository holding `folder`, looking up from the folder itself, or null. */
const repositoryOf = async (folder: string, known: Map<string, Repository | null>): Promise<Repository | null> => {
  const visited: Array<string> = [];
  let found: Repository | null = null;
  for (let at = folder; ; at = dirname(at)) {
    const cached = known.get(at);
    if (cached !== undefined) {
      found = cached;
      break;
    }
    visited.push(at);
    const gitdir = await gitdirIn(at);
    if (gitdir !== null) {
      found = { dir: at, gitdir, common: await commonOf(gitdir) };
      break;
    }
    if (dirname(at) === at) break;
  }
  for (const each of visited) known.set(each, found);
  return found;
};

/** A path inside the repository with `/` between names, or null when it is not inside. */
const insideOf = (repository: string, file: string) => {
  const path = relative(repository, file);
  return path === "" || path.startsWith("..") || isAbsolute(path) ? null : path.split(sep).join("/");
};

const HEAD = 1;
const WORKDIR = 2;
const STAGE = 3;

/** Of `paths` in one repository, those that differ from its last commit, staged or not. */
const changedIn = async (repository: Repository, paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const rows = await git.statusMatrix({
    fs: repository.common === null ? fs : worktreeFs(repository.gitdir, repository.common),
    dir: repository.dir,
    gitdir: repository.gitdir,
    filepaths: [...paths],
    refresh: false,
  });
  const wanted = new Set(paths);
  return rows
    .filter((row) => wanted.has(row[0]) && !(row[HEAD] === row[WORKDIR] && row[HEAD] === row[STAGE]))
    .map((row) => row[0])
    .sort();
};

const uncommitted = async (
  files: ReadonlyArray<{ readonly folder: string; readonly path: string }>,
): Promise<ReadonlyArray<UncommittedFiles>> => {
  const known = new Map<string, Repository | null>();
  const byRepository = new Map<string, { repository: Repository; paths: Set<string> }>();
  for (const { folder, path } of files) {
    const file = join(folder, ...path.split("/"));
    const repository = await repositoryOf(dirname(file), known);
    const inside = repository === null ? null : insideOf(repository.dir, file);
    if (repository === null || inside === null) continue;
    const entry = byRepository.get(repository.dir) ?? { repository, paths: new Set<string>() };
    entry.paths.add(inside);
    byRepository.set(repository.dir, entry);
  }
  const found: Array<UncommittedFiles> = [];
  for (const { repository, paths } of byRepository.values()) {
    // A repository that cannot be read, such as one with a damaged index, says nothing.
    const changed = await changedIn(repository, [...paths]).catch(() => []);
    if (changed.length > 0) found.push({ repository: repository.dir, paths: changed });
  }
  return found.sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0));
};

/**
 * The repository Git finds from `folder`, by the real path of its top folder, so two spellings of
 * one repository, through `..` or a link, are the same one, and a repository nested in another is
 * its own (#742). The folder is resolved as the kernel walks it, a link before the `..` after it,
 * never by taking `..` off its spelling first. Null when the folder is in none, cannot be read, or
 * is not an absolute path, which the command's own folder rules refuse.
 */
const repositoryFrom = async (folder: string): Promise<string | null> => {
  if (!isAbsolute(folder)) return null;
  const real = await realpath(folder);
  const found = await repositoryOf(real, new Map());
  return found === null ? null : realpath(found.dir);
};

/** Where a clone keeps its default branch, in the order the hub tries them. */
const MAIN_REFS = ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/heads/main"];

/**
 * The names directly in `directory` on the default branch of the repository whose top is `top`, as
 * this clone has it, for the claims register (ADR 037). Empty when the branch has no such folder,
 * null when the repository or the branch cannot be read.
 */
const namesOnMain = async (top: string, directory: string): Promise<ReadonlyArray<string> | null> => {
  const repository = await repositoryOf(top, new Map());
  if (repository === null || repository.dir !== top) return null;
  const files = repository.common === null ? fs : worktreeFs(repository.gitdir, repository.common);
  for (const ref of MAIN_REFS) {
    const oid = await git.resolveRef({ fs: files, gitdir: repository.gitdir, ref }).catch(() => null);
    if (oid === null) continue;
    const found = await git
      .readTree({ fs: files, gitdir: repository.gitdir, oid, filepath: directory })
      .catch((error: unknown) => (error instanceof git.Errors.NotFoundError ? { tree: [] } : null));
    return found === null ? null : found.tree.map((entry) => entry.path);
  }
  return null;
};

/** The nearest folder above `path`, or `path` itself, that exists, by its real path, with the names left below it. */
const nearestReal = async (path: string): Promise<{ readonly real: string; readonly below: ReadonlyArray<string> }> => {
  const below: Array<string> = [];
  for (let at = path; ; at = dirname(at)) {
    const real = await realpath(at).catch(() => null);
    if (real !== null) return { real, below };
    if (dirname(at) === at) return { real: at, below };
    below.unshift(basename(at));
  }
};

/**
 * An absolute path as the file system reads it: each existing name is followed through its links
 * before the `..` after it steps up, so `link/../plan.md` is the file beside the link's target, as a
 * write there lands. Names below the first one that does not exist are read as written.
 */
const followed = async (path: string): Promise<string> => {
  const root = parse(path).root;
  let at = root;
  let exists = true;
  // The root, such as `C:\` or a UNC share, is kept as it is and not read as a name.
  for (const name of path
    .slice(root.length)
    .split(/[\\/]/)
    .filter((each) => each !== "" && each !== ".")) {
    if (name === "..") {
      at = dirname(at);
      continue;
    }
    const next = join(at, name);
    const real: string | null = exists ? await realpath(next).catch(() => null) : null;
    exists = real !== null;
    at = real ?? next;
  }
  return at;
};

/**
 * The repository an absolute path is in and the path inside it, for the claims register (#1449),
 * or null when it is in none. Links are followed before each `..`, so `..` cannot step out of it.
 */
const placeOf = async (path: string): Promise<{ readonly top: string; readonly path: string } | null> => {
  if (!isAbsolute(path)) return null;
  const { real, below } = await nearestReal(await followed(path));
  const found = await repositoryOf(real, new Map());
  if (found === null) return null;
  const top = await realpath(found.dir);
  const file = join(real, ...below);
  const inside = file === top ? "" : insideOf(top, file);
  // The top folder itself is "", which holds every path: deleting it deletes what you took over.
  return inside === null ? null : { top, path: inside };
};

/** The branch checked out in the repository whose top is `top`, by its short name, or null. */
const currentBranch = async (top: string): Promise<string | null> => {
  const repository = await repositoryOf(top, new Map());
  if (repository === null) return null;
  const files = repository.common === null ? fs : worktreeFs(repository.gitdir, repository.common);
  const branch = await git.currentBranch({ fs: files, gitdir: repository.gitdir, fullname: false });
  return branch ?? null;
};

/** How many folders `repositoriesIn` reads at most before it says it did not see them all. */
const REPOSITORY_SCAN_LIMIT = 20_000;
/** Git's own folder, and folders that hold installed dependencies, never a checkout someone works in. */
const SKIPPED = new Set([".git", "node_modules"]);

/**
 * The repositories `folder` reaches (#1537): the one Git finds from it, and every one inside it, by
 * the real path of each top folder, and whether the scan saw every folder. Links are not followed
 * and Git's own and dependency folders are skipped, hidden ones are not; a scan that reads more
 * folders than its limit stops and says so, and the caller closes the folder whole rather than miss
 * one.
 */
const repositoriesIn = async (folder: string): Promise<{ tops: ReadonlyArray<string>; complete: boolean }> => {
  // A folder that is not there holds no repository.
  const real = isAbsolute(folder) ? await realpath(folder).catch(() => null) : null;
  if (real === null) return { tops: [], complete: true };
  const found = new Set<string>();
  const holding = await repositoryOf(real, new Map());
  if (holding !== null) found.add(await realpath(holding.dir));
  const queue: Array<string> = [real];
  for (let read = 0; read < queue.length; read++) {
    if (read >= REPOSITORY_SCAN_LIMIT) return { tops: [...found], complete: false };
    const entries = await readdir(queue[read] as string, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue;
      const child = join(queue[read] as string, entry.name);
      if ((await gitdirIn(child)) !== null) found.add(child);
      queue.push(child);
    }
  }
  return { tops: [...found], complete: true };
};

/** Whether `path` is there, as a file or folder, without following a link at it. */
const present = async (path: string) => (await lstat(path).catch(() => null)) !== null;

/** Whether `path` is a folder itself, never a link to one. */
const plainFolder = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() === true;

/** Whether the packed refs at `packed` hold `ref`, read from the file itself, never through a link. */
const packedHolds = async (packed: string, ref: string): Promise<boolean> => {
  if ((await lstat(packed).catch(() => null))?.isFile() !== true) return false;
  const text = await readFile(packed, { encoding: "utf8", flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  return text.split("\n").some((line) => line.trim().split(" ")[1] === ref);
};

/** Where a repository's refs are: its shared Git folder and its worktree's own, as real paths. */
interface RefPlaces {
  readonly common: string;
  readonly gitdir: string;
}

const refPlacesOf = async (repository: Repository): Promise<RefPlaces> => {
  const gitdir = await realpath(repository.gitdir).catch(() => repository.gitdir);
  const common = repository.common === null ? gitdir : await realpath(repository.common).catch(() => repository.common);
  return { common: common ?? gitdir, gitdir };
};

/**
 * Whether `branch` is a branch name Git accepts (`git check-ref-format`): no part empty, starting with
 * a dot or ending with `.lock`, no `..`, `@{`, backslash, control character, space or any of `~^:?*[`,
 * and not ending with a dot. So its ref file is always inside `refs/heads`, whatever separator the
 * platform's paths take.
 */
const branchNamed = (branch: string): boolean => {
  if (branch.endsWith(".") || branch.includes("..") || branch.includes("@{")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git refuses control characters in ref names.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(branch)) return false;
  return branch.split("/").every((name) => name !== "" && !name.startsWith(".") && !name.endsWith(".lock"));
};

/** A loose ref that holds a commit itself, the only kind `branchFiles` closes as a file. */
const LOOSE_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?\s*$/;

/**
 * What closes the branch whose ref is `names` (from `common`): its loose ref, when it is a plain file
 * that holds a commit; the folder its loose ref would be written in, when only the packed refs hold
 * it; nothing for a branch not made yet, which the call-level check covers (#1449); and anything else
 * (a symbolic ref, a link on the way or at the ref) closes the repository's whole Git folders, since
 * where Git then writes is not read here.
 */
const refFiles = async (places: RefPlaces, names: ReadonlyArray<string>): Promise<Array<string>> => {
  // The Git folders, and where a link on the way leads, since Git follows it.
  const whole = async (at: string) => {
    const link = (await lstat(at).catch(() => null))?.isSymbolicLink() === true;
    const target = link ? await realpath(at).catch(() => null) : null;
    return [...new Set([places.common, places.gitdir, ...(target === null ? [] : [target])])];
  };
  let folder = places.common;
  for (const name of names.slice(0, -1)) {
    folder = join(folder, name);
    const stats = await lstat(folder).catch(() => null);
    if (stats === null) break;
    if (!stats.isDirectory()) return await whole(folder);
  }
  const loose = join(places.common, ...names);
  const stats = await lstat(loose).catch(() => null);
  if (stats !== null) {
    if (!stats.isFile()) return await whole(loose);
    const text = await readFile(loose, { encoding: "utf8", flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
    return LOOSE_COMMIT.test(text) ? [loose] : await whole(loose);
  }
  const packedFile = join(places.common, "packed-refs");
  const packedStats = await lstat(packedFile).catch(() => null);
  // Packed refs Git reads through a link may hold the branch where it is not read here.
  if (packedStats !== null && !packedStats.isFile()) return await whole(packedFile);
  const packed = await packedHolds(packedFile, names.join("/")).catch(() => false);
  return packed ? await closedAround(places.common, names) : [];
};

/** The deepest folder that is there on the way to ref `names` (from `base`), where Git would write it. */
const closedAround = async (base: string, names: ReadonlyArray<string>): Promise<Array<string>> => {
  let folder = base;
  for (const name of names.slice(0, -1)) {
    if (!(await plainFolder(join(folder, name)))) break;
    folder = join(folder, name);
  }
  return [folder];
};

/**
 * The files whose change moves branch `branch` of the repository whose top is `top` (#1537), in the
 * Git folder the repository's worktrees share: its loose ref and the packed refs, which Git rewrites
 * to delete or repack a branch; or the whole ref table, and where a link to it leads, in a repository
 * that keeps its refs in one. Only what is there is named, since a sandbox cannot close a missing file
 * without hiding it from Git's reads (see `refFiles`). The hub only reads here, never writes.
 */
const branchFiles = async (top: string, branch: string): Promise<ReadonlyArray<string>> => {
  const repository = await repositoryOf(top, new Map());
  if (repository === null) return [];
  const places = await refPlacesOf(repository);
  const table = join(places.common, "reftable");
  // Git reads the ref table only when the repository's config says so: with one there, both stores
  // are closed, the table whole and where a link to it leads.
  const tables = (await present(table)) ? [table, await realpath(table).catch(() => table)] : [];
  const packed = join(places.common, "packed-refs");
  // A ref store that changes under the read, as Git packs or prunes it, is closed whole.
  const files = branchNamed(branch)
    ? await refFiles(places, ["refs", "heads", ...branch.split("/")]).catch(() => [places.common, places.gitdir])
    : [];
  const packedFiles = (await present(packed)) ? [packed, await realpath(packed).catch(() => packed)] : [];
  return [...new Set([...tables, ...files, ...packedFiles])];
};

/** The hub's reader of Git state. */
export const GitWorkspaceLive = Layer.succeed(
  GitWorkspace,
  GitWorkspace.of({
    uncommitted: (files) => Effect.promise(() => uncommitted(files).catch(() => [])),
    repository: (folder) => Effect.promise(() => repositoryFrom(folder).catch(() => null)),
    realFolder: (folder) =>
      Effect.promise(() => (isAbsolute(folder) ? realpath(folder).catch(() => null) : Promise.resolve(null))),
    namesOnMain: (repository, directory) => Effect.promise(() => namesOnMain(repository, directory).catch(() => null)),
    placeOf: (path) => Effect.promise(() => placeOf(path).catch(() => null)),
    currentBranch: (top) => Effect.promise(() => currentBranch(top).catch(() => null)),
    repositoriesIn: (folder) =>
      Effect.promise(() => repositoriesIn(folder).catch(() => ({ tops: [], complete: false }))),
    branchFiles: (top, branch) => Effect.promise(() => branchFiles(top, branch).catch(() => [])),
  }),
);
