import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { MemoryProjects } from "@hobbots/agents";
import { memoryProjectIdentity } from "@hobbots/domain";
import { Effect, Layer } from "effect";

const execFileAsync = promisify(execFile);

/** The first line of `file`, trimmed, or null when it cannot be read. */
const firstLine = (file: string) =>
  readFile(file, "utf8").then(
    (text) => text.split("\n")[0]?.trim() ?? null,
    () => null,
  );

/** `target` as an absolute path, relative to `from` when it is not one already. */
const absolute = (from: string, target: string) => (isAbsolute(target) ? target : resolve(from, target));

/**
 * The Git folder of the repository whose top is `folder`: its `.git` folder, or for a linked
 * worktree or a submodule, the folder its `.git` file's `gitdir:` line names. Null when there is none.
 */
const gitDirOf = async (folder: string): Promise<string | null> => {
  const dotGit = join(folder, ".git");
  const stats = await lstat(dotGit).catch(() => null);
  if (stats?.isDirectory()) return dotGit;
  if (!stats?.isFile()) return null;
  const line = (await firstLine(dotGit)) ?? "";
  const target = line.startsWith("gitdir:") ? line.slice("gitdir:".length).trim() : "";
  return target === "" ? null : absolute(folder, target);
};

/**
 * The `origin` remote of the repository whose top is `folder`, or null. A linked worktree keeps its
 * remotes in the config of the repository it belongs to, which its Git folder's `commondir` names.
 * Read with `git config --file`, from that one file, which hobs can read but never write (ADR 014),
 * and which runs no includes, hooks or configured programs.
 */
const originOf = async (folder: string): Promise<string | null> => {
  const gitDir = await gitDirOf(folder);
  if (gitDir === null) return null;
  const common = await firstLine(join(gitDir, "commondir"));
  const configDir = common === null || common === "" ? gitDir : absolute(gitDir, common);
  const { stdout } = await execFileAsync(
    "git",
    ["config", "--file", join(configDir, "config"), "--get", "remote.origin.url"],
    { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10_000 },
  );
  return stdout.trim() || null;
};

/**
 * Each folder's project identity (ADR 028): its normalized `origin` remote, so two clones share one
 * project, or the folder's name when it has none or it cannot be read.
 */
export const MemoryProjectsLive = Layer.succeed(
  MemoryProjects,
  MemoryProjects.of({
    of: (folder) =>
      Effect.promise(() => originOf(folder).catch(() => null)).pipe(
        Effect.map((origin) => memoryProjectIdentity(origin, basename(folder))),
      ),
    origin: (folder) => Effect.promise(() => originOf(folder).catch(() => null)),
  }),
);
