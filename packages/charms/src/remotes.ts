import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { type GitHubRepository, githubRepositoryOf } from "@hobbots/domain";
import { Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The GitHub repository a hob's folder works on: the one its `origin` remote names. Read from the
 * folder's own `.git/config`, which hobs can read but never write (ADR 014), so a hob cannot point
 * the Charm at another repository. A folder that is not itself a repository's top, or whose
 * `.git` is a file pointing elsewhere, has none.
 */
export class GitRemotes extends Context.Service<
  GitRemotes,
  { readonly repositoryOf: (folder: string) => Effect.Effect<GitHubRepository | null> }
>()("@hobbots/charms/GitRemotes") {
  /**
   * Reads the remote with `git config --file`, which reads that one file and runs nothing: no
   * includes, hooks or configured programs.
   */
  static readonly layer = Layer.effect(
    GitRemotes,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return GitRemotes.of({
        repositoryOf: (folder) =>
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
            return githubRepositoryOf(remote);
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.orElseSucceed(() => null),
          ),
      });
    }),
  );
}
