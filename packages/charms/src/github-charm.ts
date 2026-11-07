import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  CharmTools,
  type CharmTurn,
  type HubCallStep,
  type HubPlanContext,
  HubRefusal,
  type HubTools,
  hubAction,
  makeCharmCallRunner,
  makeHubActions,
  readBacksOf,
  redactedAnswer,
  type ToolAccess,
} from "@hobbots/agents";
import {
  type AgentId,
  GITHUB_PUSH_TOOL,
  GITHUB_TOOLS,
  GITHUB_WRITE_TOOLS,
  type GitHubRepository,
  type GitHubToolInput,
  GitHubToolInputs,
  type GitHubToolName,
  GitHubWriteInputs,
  githubItemText,
  githubRepositoryText,
  githubSearchQuery,
  githubSearchText,
  githubToolJsonSchema,
  githubWriteToolJsonSchema,
  repositorySlug,
  trimTrailingSlashes,
} from "@hobbots/domain";
import { decideHubCall, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Effect, Layer, Schema } from "effect";
import { GitPush } from "./git-push.ts";
import { GitHubCredential } from "./github-account.ts";
import { GitHubApi } from "./github-api.ts";
import type { GitHubError } from "./github-error.ts";
import { GITHUB_CHARM } from "./github-operations.ts";
import { makeGitHubPush, pushReadBack } from "./github-push.ts";
import { makeGitHubWrites } from "./github-writes.ts";
import { GitRemotes } from "./remotes.ts";

/**
 * The GitHub Charm's actions as hub tools (#317, #323, #324, ADR 014): its reads, and its writes. A turn offers them only to a hob
 * the user gave the Charm, while GitHub is connected on the hub (#322). Each call is decided by the
 * policy engine on the repository the hub found from the hob's own folder, then read on the hub with
 * the connected account. Nothing a hob writes names the repository, and no credential reaches it.
 * The reads, opening pull requests and commenting run through the hub action pipeline (ADR 031),
 * which decides, asks, records and sends them; Push follows (#619).
 */

const describe = (error: Schema.SchemaError) => error.message.split("\n").slice(0, 6).join("\n");

/** A read's input, of any of the three reads. */
type ReadInput = GitHubToolInput<GitHubToolName>;

/** Whether the hob still holds the GitHub Charm. Until the Charm-id grant (#620) it is `githubCharm`. */
const holdsGitHub = (access: ToolAccess) => access.policy.hob.githubCharm !== false;

/** A folder as the file system resolves it, so a link and its target are the same folder. */
const canonical = (folder: string) => {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
};

const withoutSlash = (folder: string) => (folder.length > 1 ? trimTrailingSlashes(folder) || "/" : folder);

export const GitHubCharmTools = Layer.effect(
  CharmTools,
  Effect.gen(function* () {
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

    const writes = yield* makeGitHubWrites(repositoryFor);
    const runner = yield* makeCharmCallRunner("GitHub", {
      github_push: pushReadBack(api, yield* GitPush),
      ...readBacksOf(writes),
    });
    const github = yield* makeGitHubPush(runner);
    const pushTool = GITHUB_WRITE_TOOLS.find((tool) => tool.name === GITHUB_PUSH_TOOL);
    if (pushTool === undefined) throw new Error("The GitHub Charm has no github_push tool.");

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

    /** The call's input, or a refusal saying what is wrong with it. */
    const decoded = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, raw: unknown) =>
      Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError((error) => new HubRefusal({ message: describe(error) })),
      );

    /**
     * The turn's access, and the folder and repository a call names, or a refusal when the turn has
     * no tools or the user took the Charm away during the turn.
     */
    const resolved = (turn: CharmTurn, named: string | undefined, otherwise: string) =>
      Effect.gen(function* () {
        const access = yield* turn.currentAccess;
        if (access === null) return yield* new HubRefusal({ message: `You have no tools this turn, so ${otherwise}.` });
        if (!holdsGitHub(access)) {
          return yield* new HubRefusal({ message: `The GitHub Charm is off for you now, so ${otherwise}.` });
        }
        return { access, ...(yield* repositoryFor(access, named)) };
      });

    const push = (turn: CharmTurn, raw: unknown, step: HubCallStep | undefined) =>
      Effect.gen(function* () {
        const input = yield* decoded(GitHubWriteInputs.github_push, raw);
        const { access, folder, repository } = yield* resolved(turn, input.folder, "nothing can be pushed");
        return yield* github.push(turn, access, folder, repository, input, step);
      });

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

    const actions = makeHubActions({
      owner: { _tag: "Charm", declaration: GITHUB_CHARM, name: "GitHub", holds: holdsGitHub },
      actions: [
        ...GITHUB_TOOLS.map((tool) =>
          hubAction({
            tool: { ...tool, inputSchema: githubToolJsonSchema(tool.name) },
            input: GitHubToolInputs[tool.name],
            effect: "read",
            otherwise: "GitHub cannot be read",
            plan: planRead(tool.name),
          }),
        ),
        ...writes,
      ],
      decide: (approvals, base, request: PolicyRequest) => decideHubCall(engine, approvals, base, request),
      calls: runner,
    });

    /** A push, decided and sent by its own call code until it moves onto the pipeline (#619). */
    const callPush = (turn: CharmTurn, raw: unknown, step: HubCallStep | undefined) =>
      redactedAnswer(turn.redactor, push(turn, raw, step), {
        log: "A GitHub Charm call failed",
        text: "Hobbots could not reach GitHub this time. Try again.",
      });

    const call = (turn: CharmTurn, pipeline: HubTools, name: string, raw: unknown, step: HubCallStep | undefined) =>
      (name === GITHUB_PUSH_TOOL ? callPush(turn, raw, step) : pipeline.call(name, raw, step)).pipe(
        Effect.provideContext(context),
      );

    /** The tools in the order the hob has always been offered them: the reads, Push, then the other writes. */
    const offered = (pipeline: HubTools) => {
      const [reads, rest] = [pipeline.tools.slice(0, GITHUB_TOOLS.length), pipeline.tools.slice(GITHUB_TOOLS.length)];
      return [...reads, { ...pushTool, inputSchema: githubWriteToolJsonSchema(GITHUB_PUSH_TOOL) }, ...rest];
    };

    /**
     * A `git push` in one of the hob's folders whose origin is on GitHub is made with `github_push`
     * (ADR 020): Git in the sandbox cannot sign in. A push anywhere else is decided as a push.
     */
    const steersPush = (turn: CharmTurn, cwd: string) =>
      Effect.gen(function* () {
        const access = yield* turn.currentAccess;
        if (access === null) return null;
        const at = canonical(cwd);
        for (const folder of access.folders) {
          const from = relative(canonical(folder), at);
          if (from.startsWith("..") || isAbsolute(from)) continue;
          if ((yield* remotes.repositoryOf(folder)) !== null) return GITHUB_PUSH_TOOL;
        }
        return null;
      }).pipe(Effect.provideContext(context));

    return CharmTools.of({
      forTurn: (turn) =>
        Effect.gen(function* () {
          const access = yield* turn.currentAccess;
          if (access === null || access.policy.hob.githubCharm === false) return null;
          // A hob with its own app reaches GitHub without the user's account (ADR 022).
          const app = yield* credential.hobApp(turn.agentId).pipe(Effect.orElseSucceed(() => null));
          const reachable = (yield* credential.connected) || app !== null;
          if (!reachable) return null;
          const pipeline = actions(turn);
          return {
            tools: offered(pipeline),
            call: (name: string, input: unknown, step?: HubCallStep) => call(turn, pipeline, name, input, step),
            steersPush: (cwd: string) => steersPush(turn, cwd),
          };
        }).pipe(Effect.provideContext(context)),
    });
  }),
);
