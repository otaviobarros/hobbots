import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MemoryProjects } from "@hobbots/agents";
import { type GitHubRepository, githubRepositoryOf, memoryProjectIdentity } from "@hobbots/domain";
import { Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The `origin` remote of a hob's folder, read from the folder's own `.git/config`, which hobs can read
 * but never write (ADR 014), with `git config --file`, which reads that one file and runs nothing: no
 * includes, hooks or configured programs. A folder that is not itself a repository's top, whose
 * `.git` is a file pointing elsewhere, or whose remote cannot be read, has none.
 */
const originOf = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], folder: string) =>
  Effect.gen(function* () {
    const gitDir = join(folder, ".git");
    const isDirectory = yield* Effect.promise(() =>
      lstat(gitDir).then(
        (stats) => stats.isDirectory(),
        () => false,
      ),
    );
    if (!isDirectory) return null;
    const remote = yield* spawner.string(
      ChildProcess.make("git", ["config", "--file", join(gitDir, "config"), "--get", "remote.origin.url"], {
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }),
    );
    return remote.trim() === "" ? null : remote.trim();
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => null),
  );

/**
 * The GitHub repository a hob's folder works on: the one its `origin` remote names, so a hob cannot
 * point the Charm at another repository.
 */
export class GitRemotes extends Context.Service<
  GitRemotes,
  { readonly repositoryOf: (folder: string) => Effect.Effect<GitHubRepository | null> }
>()("@hobbots/charms/GitRemotes") {
  static readonly layer = Layer.effect(
    GitRemotes,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return GitRemotes.of({
        repositoryOf: (folder) =>
          Effect.map(originOf(spawner, folder), (origin) => (origin === null ? null : githubRepositoryOf(origin))),
      });
    }),
  );
}

/**
 * A folder's project in memory (ADR 028), from the same `origin` remote, so a hob cannot move a
 * folder into another project's memory and two clones of one repository share a project. A folder
 * with no remote is its folder's name.
 */
export const MemoryProjectsLive = Layer.effect(
  MemoryProjects,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return MemoryProjects.of({
      identityOf: (folder) =>
        Effect.map(originOf(spawner, folder), (origin) => memoryProjectIdentity(origin, basename(folder))),
    });
  }),
);
