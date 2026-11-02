import { CharmTools, type CharmTurn, type HubToolAnswer, type ToolAccess } from "@hobbots/agents";
import {
  GITHUB_TOOLS,
  type GitHubRepository,
  GitHubToolInputs,
  type GitHubToolName,
  githubItemText,
  githubRepositoryText,
  githubSearchQuery,
  githubSearchText,
  githubToolJsonSchema,
  isGitHubToolName,
  repositorySlug,
  trimTrailingSlashes,
} from "@hobbots/domain";
import { type PolicyContext, PolicyEngine } from "@hobbots/permissions";
import { Data, Effect, Layer, Schema } from "effect";
import { GitHubApi, type GitHubError } from "./github-api.ts";
import { GitRemotes } from "./remotes.ts";

/**
 * The GitHub Charm's read actions as hub tools (#317, ADR 014). Each call is decided by the policy
 * engine on the repository the hub found from the hob's own folder, then read on the hub with the
 * user's sign-in. Nothing a hob writes names the repository, and no credential reaches it.
 */

class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

/** Why a call under Ask did not run: a Charm call cannot pause for an approval yet. */
export const GITHUB_UNASKABLE =
  "Hobbots cannot ask you about GitHub reads yet, so the call did not run. Set Read GitHub to Allow or Never for this hob.";

const describe = (error: Schema.SchemaError) => error.message.split("\n").slice(0, 6).join("\n");

// The engine decides a GitHub read on the folder and the hob's answers alone: the sandbox and the
// model's hosts do not hold this rule, since the hub reads GitHub outside the sandbox.
const policyContext = (access: ToolAccess): PolicyContext => ({
  ...access.policy,
  sandbox: "on",
  modelHosts: [],
});

const withoutSlash = (folder: string) => (folder.length > 1 ? trimTrailingSlashes(folder) || "/" : folder);

export const GitHubCharmTools = Layer.effect(
  CharmTools,
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const remotes = yield* GitRemotes;
    const engine = yield* PolicyEngine;
    // A runtime runs each call on its own, so it carries the hub's services, its logger included.
    const context = yield* Effect.context<never>();
    const tools = GITHUB_TOOLS.map((tool) => ({ ...tool, inputSchema: githubToolJsonSchema(tool.name) }));

    /** The folder to read and its repository: the one named, which must be the hob's, or the first that has one. */
    const repositoryFor = (access: ToolAccess, named: string | undefined) =>
      Effect.gen(function* () {
        if (access.folders.length === 0) {
          return yield* new Refused({ message: "You have no folders this turn, so there is no repository to read." });
        }
        if (named !== undefined) {
          const folder = access.folders.find((f) => withoutSlash(f) === withoutSlash(named));
          if (folder === undefined) {
            return yield* new Refused({
              message: `${named} is not one of your folders. Your folders: ${access.folders.join(", ")}.`,
            });
          }
          const repository = yield* remotes.repositoryOf(folder);
          if (repository === null) {
            return yield* new Refused({
              message: `${folder} is not the top of a Git repository whose origin remote is on github.com.`,
            });
          }
          return { folder, repository };
        }
        for (const folder of access.folders) {
          const repository = yield* remotes.repositoryOf(folder);
          if (repository !== null) return { folder, repository };
        }
        return yield* new Refused({
          message: "None of your folders is the top of a Git repository whose origin remote is on github.com.",
        });
      });

    const read = (
      name: GitHubToolName,
      input: unknown,
      repository: GitHubRepository,
    ): Effect.Effect<string, Refused | GitHubError> => {
      switch (name) {
        case "github_repository":
          return api.repository(repository).pipe(Effect.map(githubRepositoryText));
        case "github_search": {
          const search = input as (typeof GitHubToolInputs)["github_search"]["Type"];
          if (search.state === "merged" && search.kind === "issue") {
            return Effect.fail(
              new Refused({ message: "Only pull requests can be merged; search issues by open, closed or all." }),
            );
          }
          return api
            .search(githubSearchQuery(repository, search), search.limit ?? 10)
            .pipe(Effect.map(githubSearchText));
        }
        case "github_item": {
          const item = input as (typeof GitHubToolInputs)["github_item"]["Type"];
          return api.item(repository, item.number, item.comments ?? 10).pipe(Effect.map(githubItemText));
        }
      }
    };

    const call = (turn: CharmTurn, name: string, raw: unknown) =>
      Effect.gen(function* () {
        if (!isGitHubToolName(name)) return yield* new Refused({ message: `Hobbots has no ${name} tool.` });
        const input = yield* Schema.decodeUnknownEffect(GitHubToolInputs[name])(raw).pipe(
          Effect.mapError((error) => new Refused({ message: describe(error) })),
        );
        const access = yield* turn.currentAccess;
        if (access === null) {
          return yield* new Refused({ message: "You have no tools this turn, so GitHub cannot be read." });
        }
        const { folder, repository } = yield* repositoryFor(access, input.folder);
        const verdict = yield* engine.decide(policyContext(access), {
          _tag: "GitHub",
          folder,
          repository: repositorySlug(repository),
        });
        if (verdict.decision === "ask")
          return yield* new Refused({ message: `${verdict.reason.message} ${GITHUB_UNASKABLE}` });
        if (verdict.decision === "deny") return yield* new Refused({ message: verdict.reason.message });
        return yield* read(name, input, repository).pipe(
          Effect.mapError((error) => new Refused({ message: error.message })),
        );
      }).pipe(
        Effect.match({
          onFailure: (refused): HubToolAnswer => ({ text: turn.redactor.text(refused.message), refused: true }),
          onSuccess: (text): HubToolAnswer => ({ text: turn.redactor.text(text), refused: false }),
        }),
        // A defect becomes an answer; an interrupted turn stays interrupted.
        Effect.catchDefect((defect) =>
          Effect.logError("A GitHub Charm call failed", defect).pipe(
            Effect.as({ text: "Hobbots could not read GitHub this time. Try again.", refused: true }),
          ),
        ),
        Effect.provideContext(context),
      );

    return CharmTools.of({
      forTurn: (turn) => ({ tools, call: (name, input) => call(turn, name, input) }),
    });
  }),
);
