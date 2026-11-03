import * as fs from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GitWorkspace, type UncommittedFiles } from "@hobbots/agents";
import { Effect, Layer } from "effect";
import git from "isomorphic-git";

/**
 * Which files a Task left uncommitted in a Git repository (#586). Git itself never runs here: a
 * repository's own config can name hooks, filters and an fsmonitor that run code, so its files are
 * read with isomorphic-git instead, which runs none of them. The index is only read, never
 * refreshed.
 */

/** A repository found above a file: its top folder and its Git folder. */
interface Repository {
  readonly dir: string;
  readonly gitdir: string;
}

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

/** The nearest repository holding `file`, looking up from its folder, or null. */
const repositoryOf = async (file: string, known: Map<string, Repository | null>): Promise<Repository | null> => {
  const visited: Array<string> = [];
  let found: Repository | null = null;
  for (let at = dirname(file); ; at = dirname(at)) {
    const cached = known.get(at);
    if (cached !== undefined) {
      found = cached;
      break;
    }
    visited.push(at);
    const gitdir = await gitdirIn(at);
    if (gitdir !== null) {
      found = { dir: at, gitdir };
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
    fs,
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
    const repository = await repositoryOf(file, known);
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

/** The hub's reader of Git state. */
export const GitWorkspaceLive = Layer.succeed(
  GitWorkspace,
  GitWorkspace.of({
    uncommitted: (files) => Effect.promise(() => uncommitted(files).catch(() => [])),
  }),
);
