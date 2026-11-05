import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { MemoryProjects } from "@hobbots/agents";
import { memoryProjectIdentity } from "@hobbots/domain";
import { Effect, Layer } from "effect";

const execFileAsync = promisify(execFile);

/**
 * The `origin` remote of the repository whose top is `folder`, or null. Read with `git config
 * --file` from the folder's own `.git/config`, which hobs can read but never write (ADR 014), and
 * which runs no includes, hooks or configured programs.
 */
const originOf = async (folder: string): Promise<string | null> => {
  const gitDir = join(folder, ".git");
  const isRepository = await lstat(gitDir).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (!isRepository) return null;
  const { stdout } = await execFileAsync(
    "git",
    ["config", "--file", join(gitDir, "config"), "--get", "remote.origin.url"],
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
  }),
);
