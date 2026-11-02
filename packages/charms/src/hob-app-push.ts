import type { AgentId, GitHubRepository } from "@hobbots/domain";
import { Data, Effect, Result } from "effect";
import type { CommitToSend, GitPush, SendPlan, StagedBranch } from "./git-push.ts";
import type { GitHubTokenScope } from "./github-account.ts";
import type { GitHubApi, GitHubWrite } from "./github-api.ts";

/**
 * Push as a hob's own app (ADR 022): the hub recreates each of the hob's commits GitHub does not have
 * with the Git database API and the hob's installation token, oldest first, sending no author,
 * committer or signature, so GitHub writes them as the hob's bot and signs them. Nothing here moves a
 * branch; the caller fetches what GitHub made and moves the branch with Git.
 */

/** GitHub refuses a file over 100 MB (GitHub's documentation on large files). */
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;

/** What recreating the hob's commits on GitHub came to. */
export type Recreated =
  /** GitHub has every commit: `tip` is its commit for the pushed one, `sent` each pair made now. */
  | {
      readonly _tag: "Made";
      readonly tip: string;
      readonly sent: ReadonlyArray<readonly [local: string, github: string]>;
      readonly scope: GitHubTokenScope;
    }
  /** Refused before anything was sent, such as a file over GitHub's limit. */
  | { readonly _tag: "Refused"; readonly message: string }
  /** Stopped midway or before: no branch moved, but objects already made may stay on GitHub. */
  | { readonly _tag: "Unpublished"; readonly message: string };

/**
 * The action a push's token is asked for: with Workflows when the branch update changes a workflow,
 * including on a retry whose commits GitHub already made.
 */
const pushScope = (repository: GitHubRepository, plan: SendPlan): GitHubTokenScope => ({
  repository,
  action: plan.workflows ? "push-workflows" : "push",
});

/** The requests a push makes: one per file, and a tree and a commit per commit at most. */
const requestsFor = (commits: ReadonlyArray<CommitToSend>) =>
  commits.reduce(
    (sum, commit) => sum + 2 + commit.changes.filter((change) => change.type === "blob" && change.sha !== null).length,
    0,
  );

/** Why recreating stops, carried as the error until it becomes the result. */
class Stop extends Data.TaggedError("Stop")<{ readonly outcome: Exclude<Recreated, { readonly _tag: "Made" }> }> {}

const unpublished = (message: string) => new Stop({ outcome: { _tag: "Unpublished", message } });

/** The object GitHub made, or why the push stops. */
const madeSha = (write: GitHubWrite<{ readonly sha: string }>, what: string) =>
  write._tag === "Done"
    ? Effect.succeed(write.value.sha)
    : Effect.fail(
        unpublished(
          write._tag === "SignedOut"
            ? `GitHub refused the hob's app while making ${what}.`
            : `${write.message} (while making ${what})`,
        ),
      );

export const recreateOnGitHub = (
  api: GitHubApi["Service"],
  git: GitPush["Service"],
  agentId: AgentId,
  staged: StagedBranch,
  repository: GitHubRepository,
  known: ReadonlyArray<string | null>,
): Effect.Effect<Recreated> =>
  Effect.gen(function* () {
    const plan = yield* git
      .toSend(staged, repository, known)
      .pipe(Effect.mapError((error) => unpublished(error.message)));
    const scope = pushScope(repository, plan);
    if (plan.tip !== null) return { _tag: "Made", tip: plan.tip, sent: [], scope } as const;

    const tooBig = plan.commits.flatMap((commit) => commit.changes).find((change) => change.size > GITHUB_FILE_LIMIT);
    if (tooBig !== undefined) {
      return yield* new Stop({
        outcome: {
          _tag: "Refused",
          message: `GitHub refuses files over 100 MB, and ${tooBig.path} is ${Math.ceil(tooBig.size / 1024 / 1024)} MB.`,
        },
      });
    }
    // Refused before anything is sent, so a push never stops midway for the hour's limit.
    const needed = requestsFor(plan.commits);
    const limit = yield* api.rateLimit(agentId, scope).pipe(Effect.mapError((error) => unpublished(error.message)));
    if (limit.remaining < needed) {
      return yield* unpublished(
        `This push needs ${needed} requests to GitHub and the hob's app has ${limit.remaining} left this hour. Try again after ${limit.resetsAt}.`,
      );
    }

    const made = new Map<string, string>();
    for (const commit of plan.commits) {
      const short = commit.sha.slice(0, 12);
      for (const change of commit.changes) {
        if (change.type !== "blob" || change.sha === null) continue;
        const bytes = yield* git.blob(staged, change.sha).pipe(Effect.mapError((error) => unpublished(error.message)));
        const sha = yield* madeSha(yield* api.gitObject(agentId, scope, { _tag: "Blob", bytes }), change.path);
        if (sha !== change.sha) return yield* unpublished(`GitHub stored ${change.path} differently from your commit.`);
      }
      // A commit that changes no file, such as a merge that keeps its first parent's files, reuses its tree.
      if (commit.tree !== commit.baseTree) {
        const entries = commit.changes.map(({ path, mode, type, sha }) => ({ path, mode, type, sha }));
        const tree = yield* madeSha(
          yield* api.gitObject(agentId, scope, { _tag: "Tree", baseTree: commit.baseTree, entries }),
          `the files of ${short}`,
        );
        // Trees are named by their content, so GitHub's matches the hob's exactly or something differs.
        if (tree !== commit.tree) return yield* unpublished(`GitHub made different files for commit ${short}.`);
      }
      const parents = commit.parents.map((parent) => parent.github ?? made.get(parent.local) ?? parent.local);
      const sha = yield* madeSha(
        yield* api.gitObject(agentId, scope, { _tag: "Commit", message: commit.message, tree: commit.tree, parents }),
        `commit ${short}`,
      );
      made.set(commit.sha, sha);
    }
    const tip = made.get(staged.commit);
    if (tip === undefined) return yield* unpublished("The hub did not make the pushed commit on GitHub.");
    return { _tag: "Made", tip, sent: [...made], scope } as const;
  }).pipe(
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? result.success : result.failure.outcome)),
  );
