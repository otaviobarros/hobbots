import * as fs from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
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

/** How far below a folder `repositoriesIn` looks, and how many folders it reads at most. */
const REPOSITORY_DEPTH = 3;
const REPOSITORY_SCAN_LIMIT = 2_000;
/** Folders that hold installed dependencies, never a checkout someone works in. */
const SKIPPED = new Set(["node_modules"]);

/**
 * The repositories `folder` reaches (#1537): the one Git finds from it, and those inside it up to a
 * few folders down, by the real path of each top folder. Links are not followed and hidden or
 * dependency folders are skipped, so the scan stays small; a repository nested deeper is still
 * covered by the call-level check (#1449).
 */
const repositoriesIn = async (folder: string): Promise<ReadonlyArray<string>> => {
  if (!isAbsolute(folder)) return [];
  const real = await realpath(folder);
  const found = new Set<string>();
  const holding = await repositoryOf(real, new Map());
  if (holding !== null) found.add(await realpath(holding.dir));
  let level: Array<string> = [real];
  let read = 0;
  for (let depth = 0; depth < REPOSITORY_DEPTH && level.length > 0; depth++) {
    const next: Array<string> = [];
    for (const dir of level) {
      if (read++ >= REPOSITORY_SCAN_LIMIT) return [...found];
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
        const child = join(dir, entry.name);
        if ((await gitdirIn(child)) !== null) found.add(child);
        next.push(child);
      }
    }
    level = next;
  }
  return [...found];
};

/** Whether `path` is there, as a file or folder, without following a link at it. */
const present = async (path: string) => (await lstat(path).catch(() => null)) !== null;

/** Whether `path` is a folder itself, never a link to one. */
const plainFolder = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() === true;

/** The commit the packed refs at `packed` give `ref`, read from the file itself, never through a link. */
const packedCommit = async (packed: string, ref: string): Promise<string | null> => {
  if ((await lstat(packed).catch(() => null))?.isFile() !== true) return null;
  const text = await readFile(packed, { encoding: "utf8", flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  for (const line of text.split("\n")) {
    const [oid, name] = line.trim().split(" ");
    if (name === ref && oid !== undefined && /^[0-9a-f]{40,64}$/.test(oid)) return oid;
  }
  return null;
};

/**
 * Writes back the loose ref `names` (from the Git folder, `refs` first) of a branch only the packed
 * refs hold, with the commit they give it, as Git does to move it (#1537), and under Git's own lock on
 * the ref (`<ref>.lock`, made only if no one holds it): while it is held no Git command moves,
 * deletes or repacks the branch, so the commit is read again under the lock and the ref never comes
 * back stale or deleted. Every folder on the way is a folder itself, never a link, made where
 * missing, so the write stays in the repository's refs. Anything unexpected, a lock someone holds
 * included, leaves the ref as it is.
 */
const restoreLooseRef = async (common: string, names: ReadonlyArray<string>) => {
  let folder = join(common, "refs");
  if (!(await plainFolder(folder))) return;
  for (const name of names.slice(1, -1)) {
    folder = join(folder, name);
    if ((await lstat(folder).catch(() => null)) === null) await mkdir(folder).catch(() => undefined);
    if (!(await plainFolder(folder))) return;
  }
  const loose = join(folder, names.at(-1) as string);
  const lock = `${loose}.lock`;
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const held = await open(lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644).catch(() => null);
  if (held === null) return;
  let written = false;
  try {
    const commit =
      (await present(loose)) || (await realpath(folder)) !== folder
        ? null
        : await packedCommit(join(common, "packed-refs"), names.join("/"));
    if (commit !== null) {
      await held.writeFile(`${commit}\n`);
      await held.sync();
      written = true;
    }
  } finally {
    await held.close();
  }
  // The lock becomes the ref, as Git commits a ref; once renamed it is no longer ours to remove.
  if (written) await rename(lock, loose).catch(() => unlink(lock).catch(() => undefined));
  else await unlink(lock).catch(() => undefined);
};

/**
 * What to close when ref `names` has no loose file to close, because Git held its lock, a link stands
 * on its way, the hub may not write there, or it is not there: the deepest folder on its way from
 * `base` that is a folder itself, so no ref can be written under it, and the folder a link there
 * leads to.
 */
const closedAround = async (base: string, names: ReadonlyArray<string>): Promise<Array<string>> => {
  let folder = base;
  for (const name of names.slice(0, -1)) {
    const next = join(folder, name);
    if (!(await plainFolder(next))) {
      const target = (await lstat(next).catch(() => null))?.isSymbolicLink()
        ? await realpath(next).catch(() => null)
        : null;
      return [folder, ...(target === null ? [] : [target])];
    }
    folder = next;
  }
  return [folder];
};

/** The ref a symbolic ref at `loose` names (`ref: refs/...`), read from the file itself, if it is one. */
const symbolicTarget = async (loose: string): Promise<string | null> => {
  if ((await lstat(loose).catch(() => null))?.isFile() !== true) return null;
  const text = await readFile(loose, { encoding: "utf8", flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  const target = /^ref: (refs\/\S+)\s*$/.exec(text)?.[1];
  return target ?? null;
};

/** How many symbolic refs `refFiles` follows from one branch, as Git stops after a few. */
const MAX_SYMBOLIC_DEPTH = 5;

/** Where a repository's refs are: its shared Git folder, its worktree's own, and whether the hub may write there. */
interface RefPlaces {
  readonly common: string;
  readonly gitdir: string;
  readonly writable: boolean;
}

/** Whether `path` is `folder` or inside it. */
const within = (path: string, folder: string) => {
  const inside = relative(folder, path);
  return inside === "" || !(inside.startsWith("..") || isAbsolute(inside));
};

/**
 * The Git folders of `repository`, real paths, and whether the hub may write a ref back in them: only
 * in a Git folder inside the repository's own folder, or in a linked worktree's, kept in the shared
 * Git folder's `worktrees`, that names this worktree back. A `.git` file or a `commondir` a hob wrote
 * cannot then lead the hub to write in a repository outside its folders.
 */
const refPlacesOf = async (repository: Repository): Promise<RefPlaces> => {
  const real = (path: string) => realpath(path).catch(() => path);
  const dir = await real(repository.dir);
  const gitdir = await real(repository.gitdir);
  const common = repository.common === null ? gitdir : await real(repository.common);
  if (within(common, dir)) return { common, gitdir, writable: true };
  const back = (await readFile(join(gitdir, "gitdir"), "utf8").catch(() => "")).trim();
  const named = back === "" ? null : await real(back);
  const linked = within(gitdir, join(common, "worktrees")) && named === (await real(join(repository.dir, ".git")));
  return { common, gitdir, writable: linked };
};

/**
 * Whether `ref` is a ref name Git accepts (`git check-ref-format`): under `refs/`, no part empty,
 * starting with a dot or ending with `.lock`, no `..`, `@{`, backslash, control character, space or
 * any of `~^:?*[`, and not ending with a dot. So its file is always inside the refs folder, whatever
 * separator the platform's paths take.
 */
const refNamed = (ref: string): boolean => {
  if (!ref.startsWith("refs/") || ref.endsWith(".") || ref.includes("..") || ref.includes("@{")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git refuses control characters in ref names.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  return ref.split("/").every((name) => name !== "" && !name.startsWith(".") && !name.endsWith(".lock"));
};

/** What closes the loose ref `names` that is there: the file, or for a link, its folder, since a write may go through it. */
const looseClosed = async (base: string, names: ReadonlyArray<string>): Promise<Array<string>> =>
  (await lstat(join(base, ...names)).catch(() => null))?.isSymbolicLink() === true
    ? await closedAround(base, [...names, ""])
    : [join(base, ...names)];

/** The files whose change moves ref `ref` (`refs/...`), from `depth` symbolic refs away (see `branchFiles`). */
const refFiles = async (places: RefPlaces, ref: string, depth: number): Promise<Array<string>> => {
  // Git refuses such a name, so no loose ref can have it; it never names a file outside the refs.
  if (!refNamed(ref)) return [];
  const names = ref.split("/");
  // A worktree's own refs are in its own Git folder, and never packed.
  const own = PER_WORKTREE.some((pattern) => pattern.test(ref));
  const base = own ? places.gitdir : places.common;
  const loose = join(base, ...names);
  if (!within(loose, join(base, "refs"))) return [];
  const packed = join(places.common, "packed-refs");
  if (!own && places.writable && !(await present(loose)) && (await present(packed))) {
    await restoreLooseRef(places.common, names);
  }
  if (await present(loose)) {
    const target = depth < MAX_SYMBOLIC_DEPTH ? await symbolicTarget(loose).catch(() => null) : null;
    return [...(await looseClosed(base, names)), ...(target === null ? [] : await refFiles(places, target, depth + 1))];
  }
  // A ref a symbolic branch names moves the branch once made, and a packed branch whose loose ref
  // could not be written back moves through a file not closed yet: close around either. A branch
  // not made yet is left to the call-level check (#1449).
  const packedOnly = !own && (await packedCommit(packed, ref).catch(() => null)) !== null;
  return depth > 0 || packedOnly ? await closedAround(base, names) : [];
};

/**
 * The files whose change moves branch `branch` of the repository whose top is `top` (#1537), in the
 * Git folder the repository's worktrees share: its loose ref, and the packed refs, which Git rewrites
 * to delete or repack a branch; or the whole ref table, in a repository that keeps its refs in one,
 * since each of its files may hold any branch. A branch that only the packed refs hold gets its loose
 * ref written back first (`restoreLooseRef`), in a Git folder the hub may write in (`refPlacesOf`): a
 * ref file the sandbox closes then stands where Git would write. When that cannot be done, the folder
 * around it is closed instead, and a branch that is a symbolic ref has the ref it names closed too, in
 * the worktree's own Git folder for a ref only it keeps. Only files that are there are named, since a
 * sandbox cannot close a missing file without hiding it from Git's reads.
 */
const branchFiles = async (top: string, branch: string): Promise<ReadonlyArray<string>> => {
  const repository = await repositoryOf(top, new Map());
  if (repository === null) return [];
  const places = await refPlacesOf(repository);
  const table = join(places.common, "reftable");
  if ((await lstat(table).catch(() => null))?.isDirectory() === true) return [table];
  const packed = join(places.common, "packed-refs");
  const files = await refFiles(places, `refs/heads/${branch}`, 0);
  return [...new Set([...files, ...((await present(packed)) ? [packed] : [])])];
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
    repositoriesIn: (folder) => Effect.promise(() => repositoriesIn(folder).catch(() => [])),
    branchFiles: (top, branch) => Effect.promise(() => branchFiles(top, branch).catch(() => [])),
  }),
);
