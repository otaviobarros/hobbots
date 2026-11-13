import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  type CharmTurn,
  defineCharm,
  type HubPlanContext,
  HubRefusal,
  hubAction,
  type ToolAccess,
} from "@hobbots/agents";
import {
  type AgentId,
  GITHUB_PUSH_TOOL,
  GITHUB_TOOLS,
  type GitHubRepository,
  type GitHubToolInput,
  GitHubToolInputs,
  type GitHubToolName,
  githubItemText,
  githubRepositoryText,
  githubSearchQuery,
  githubSearchText,
  githubToolJsonSchema,
  repositorySlug,
  trimTrailingSlashes,
} from "@hobbots/domain";
import { decideHubCall, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Effect } from "effect";
import { GitHubCredential } from "./github-account.ts";
import { GitHubApi } from "./github-api.ts";
import type { GitHubError } from "./github-error.ts";
import { GITHUB_CHARM } from "./github-operations.ts";
import { makeGitHubPush } from "./github-push.ts";
import { makeGitHubWrites } from "./github-writes.ts";
import { GitRemotes } from "./remotes.ts";

/**
 * The GitHub Charm's actions as hub tools (#317, #323, #324, ADR 014): its reads, and its writes. A turn offers them only to a hob
 * the user gave the Charm, while GitHub is connected on the hub (#322). Each call is decided by the
 * policy engine on the repository the hub found from the hob's own folder, then read on the hub with
 * the connected account. Nothing a hob writes names the repository, and no credential reaches it.
 * Every one of them runs through the hub action pipeline (ADR 031), which decides, asks, records and
 * sends it. The Charm is registered with the others in `Charms.layer`.
 */

/** A read's input, of any of the three reads. */
type ReadInput = GitHubToolInput<GitHubToolName>;

/** A folder as the file system resolves it, so a link and its target are the same folder. */
const canonical = (folder: string) => {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
};

const withoutSlash = (folder: string) => (folder.length > 1 ? trimTrailingSlashes(folder) || "/" : folder);

export const GitHubCharm = Effect.gen(function* () {
  const api = yield* GitHubApi;
  const remotes = yield* GitRemotes;
  const engine = yield* PolicyEngine;
  const credential = yield* GitHubCredential;
  // A runtime runs each call on its own, so it carries the hub's services, its logger included.
  const context = yield* Effect.context<never>();

  /** The folder to read and its repository: the one named, which must be the hob's, or the first that has one. */
  const repositoryFor = (access: ToolAccess, named: string | undefined) =>
    Effect.gen(function* () {
      if (access.folders.length === 0) {
        return yield* new HubRefusal({
          message: "You have no folders this turn, so there is no repository to read.",
        });
      }
      if (named !== undefined) {
        const folder = access.folders.find((f) => withoutSlash(f) === withoutSlash(named));
        if (folder === undefined) {
          return yield* new HubRefusal({
            message: `${named} is not one of your folders. Your folders: ${access.folders.join(", ")}.`,
          });
        }
        const repository = yield* remotes.repositoryOf(folder);
        if (repository === null) {
          return yield* new HubRefusal({
            message: `${folder} is not the top of a Git repository whose origin remote is on github.com.`,
          });
        }
        return { folder, repository };
      }
      for (const folder of access.folders) {
        const repository = yield* remotes.repositoryOf(folder);
        if (repository !== null) return { folder, repository };
      }
      return yield* new HubRefusal({
        message: "None of your folders is the top of a Git repository whose origin remote is on github.com.",
      });
    });

  // The writes in the order the hob has always been offered them, after the reads: Push first.
  const writes = [yield* makeGitHubPush(repositoryFor), ...(yield* makeGitHubWrites(repositoryFor))];

  const read = (
    agentId: AgentId,
    name: GitHubToolName,
    input: ReadInput,
    repository: GitHubRepository,
  ): Effect.Effect<string, HubRefusal | GitHubError> => {
    switch (name) {
      case "github_repository":
        return api.repository(agentId, repository).pipe(Effect.map(githubRepositoryText));
      case "github_search": {
        const search = input as (typeof GitHubToolInputs)["github_search"]["Type"];
        if (search.state === "merged" && search.kind === "issue") {
          return Effect.fail(
            new HubRefusal({ message: "Only pull requests can be merged; search issues by open, closed or all." }),
          );
        }
        return api
          .search(agentId, repository, githubSearchQuery(repository, search), search.limit ?? 10)
          .pipe(Effect.map(githubSearchText));
      }
      case "github_item": {
        const item = input as (typeof GitHubToolInputs)["github_item"]["Type"];
        return api.item(agentId, repository, item.number, item.comments ?? 10).pipe(Effect.map(githubItemText));
      }
    }
  };

  /**
   * A read, planned for the pipeline: the `github.read` request on the repository of the hob's folder,
   * and the read itself, under the sign-in that reaches the repository. The app's sign-in also reads
   * public repositories it is not installed on (ADR 020), and the read must use the sign-in that check
   * was made for.
   */
  const planRead =
    (name: GitHubToolName) =>
    (input: ReadInput, { turn, access }: HubPlanContext) =>
      Effect.gen(function* () {
        const { folder, repository } = yield* repositoryFor(access, input.folder);
        const slug = repositorySlug(repository);
        const request: PolicyRequest = {
          _tag: "Charm",
          charm: GITHUB_CHARM.id,
          operation: "github.read",
          folder,
          site: { repository: slug },
          targets: [slug],
        };
        return {
          request,
          card: { arguments: { ...input, repository: slug } },
          send: credential
            .onRepository(
              turn.agentId,
              repository,
              Effect.suspend(() => read(turn.agentId, name, input, repository)),
            )
            .pipe(
              Effect.mapError((error) =>
                error instanceof HubRefusal ? error : new HubRefusal({ message: error.message }),
              ),
            ),
        };
      });

  const actions = [
    ...GITHUB_TOOLS.map((tool) =>
      hubAction({
        tool: { ...tool, inputSchema: githubToolJsonSchema(tool.name) },
        input: GitHubToolInputs[tool.name],
        effect: "read",
        // Every read is decided as reading GitHub: a delegation names that answer to its lead (#1348).
        operation: "github.read",
        otherwise: "GitHub cannot be read",
        plan: planRead(tool.name),
      }),
    ),
    ...writes,
  ];

  /**
   * Whether a `git push` from `cwd` is in one of the hob's folders whose origin is on GitHub, where
   * the Charm makes it with `github_push` (ADR 020, ADR 031): Git in the sandbox cannot sign in. A push
   * anywhere else is decided as a push.
   */
  const pushesFromGitHub = (turn: CharmTurn, cwd: string) =>
    Effect.gen(function* () {
      const access = yield* turn.currentAccess;
      if (access === null) return false;
      const at = canonical(cwd);
      for (const folder of access.folders) {
        const from = relative(canonical(folder), at);
        if (from.startsWith("..") || isAbsolute(from)) continue;
        if ((yield* remotes.repositoryOf(folder)) !== null) return true;
      }
      return false;
    });

  return defineCharm({
    declaration: GITHUB_CHARM,
    name: "GitHub",
    actions,
    decide: (approvals, base, request: PolicyRequest) => decideHubCall(engine, approvals, base, request),
    // A hob with its own app reaches GitHub without the user's account (ADR 022).
    connected: (agentId) =>
      Effect.gen(function* () {
        const app = yield* credential.hobApp(agentId).pipe(Effect.orElseSucceed(() => null));
        return (yield* credential.connected) || app !== null;
      }),
    // The Push it takes over is steered to github_push from a folder whose origin is on GitHub.
    takeovers: [{ operation: "push", tool: GITHUB_PUSH_TOOL, appliesIn: pushesFromGitHub }],
    // Every write reads GitHub back, and one that stays uncertain in a Task is settled on that Task (ADR 038).
    writesOutsideChats: true,
    context,
  });
});
