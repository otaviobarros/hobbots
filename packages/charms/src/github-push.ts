import {
  type HubAction,
  type HubPlanContext,
  HubRefusal,
  hubAction,
  type ReadBack,
  type WriteOutcome,
} from "@hobbots/agents";
import {
  type AgentId,
  GITHUB_WRITE_TOOLS,
  type GitHubPushPlan,
  type GitHubRepository,
  type GitHubWriteInput,
  GitHubWriteInputs,
  githubPushSummary,
  githubWriteToolJsonSchema,
  repositorySlug,
} from "@hobbots/domain";
import type { PolicyRequest } from "@hobbots/permissions";
import { Context, Effect, Redacted, Result } from "effect";
import { GitPush, type PushTransport, type StagedBranch } from "./git-push.ts";
import { GitHubCredential, type GitHubTokenScope, refusedTwice } from "./github-account.ts";
import { githubActor } from "./github-actor.ts";
import { GitHubApi, type GitHubError } from "./github-api.ts";
import { branchNameCheck, pinnedPlan, type RepositoryFor } from "./github-writes.ts";
import { recreateOnGitHub } from "./hob-app-push.ts";

/**
 * The GitHub Charm's Push (ADR 020, #323), as a hub action (ADR 031). Its plan fixes the commit the
 * hob's branch points to and reads GitHub's side before the call is decided, so the approval card
 * shows, and its digest covers, exactly what is sent. It plans the built-in `Push` request, which the
 * GitHub Charm takes over, so under Balanced a push asks, and a force push, or one to the default
 * branch, asks once only. The hub action pipeline decides, asks, records the step and the keyed call,
 * and sends it from the hub's staging repository.
 */

/** How the hub pushes: over HTTPS with the token, or over SSH with the user's agent (ADR 020). */
export interface GitHubPushSettings {
  readonly over: "https" | "ssh";
  /** The SSH agent socket an SSH push uses, such as 1Password's; the hub's own SSH_AUTH_SOCK when absent. */
  readonly agentSocket?: string | undefined;
}

export const GitHubPushSettings = Context.Reference<GitHubPushSettings>("@hobbots/charms/GitHubPushSettings", {
  defaultValue: () => ({ over: "https" }),
});

/** The site a push acts on: the repository and branch, so two pushes there never overlap while one is uncertain. */
const pushSite = (repository: GitHubRepository, branch: string) =>
  `github.com/${repositorySlug(repository)} refs/heads/${branch}`;

const short = (commit: string) => commit.slice(0, 12);

/** Whether the branch on GitHub is at the pushed commit, or at the one GitHub made from it for the hob's app. */
const alreadyThere = (replaces: string | null, commit: string, sentAs: string | null) =>
  replaces === commit || (sentAs !== null && replaces === sentAs);

/**
 * Why a push that would create a branch with no commit GitHub lacks is refused (#1219): the branch is
 * at a commit GitHub already has, so the hob's own work, if any, was never committed.
 */
const noNewCommits = (plan: GitHubPushPlan) =>
  `${plan.branch} is at ${short(plan.commit)}, which ${plan.repository} already has, so pushing it would only create ${plan.remoteBranch} with no new commits. Nothing was pushed. ` +
  "Commit your work first, then push. If your commit was refused, tell the user why instead of pushing.";

/** The most commit pairs a pushed answer lists, so a long history does not fill the hob's context. */
const PAIRS_SHOWN = 20;

/**
 * What the hob is told when a push took effect. A hob's app pushes commits GitHub made anew, so the
 * hob is given both IDs of each (ADR 022).
 */
const pushedText = (plan: GitHubPushPlan, sent: ReadonlyArray<readonly [string, string]> = []) => {
  const pushed = `Pushed ${short(plan.commit)} to ${plan.repository} branch ${plan.remoteBranch}. Its commits are on GitHub now: https://github.com/${plan.repository}/tree/${plan.remoteBranch}`;
  if (plan.actingAs._tag !== "HobApp") return pushed;
  const pairs = sent.slice(-PAIRS_SHOWN).map(([local, github]) => `  ${short(local)} is ${short(github)} on GitHub`);
  return [
    pushed,
    `GitHub made the commits again as ${plan.actingAs.bot} and signed them, so their IDs and dates differ from yours. Your branch still points at your own commits.`,
    ...(sent.length > PAIRS_SHOWN ? [`The last ${PAIRS_SHOWN} of ${sent.length}:`] : []),
    ...pairs,
  ].join("\n");
};

/**
 * Reads a push back: it took effect when the branch on GitHub is at the pushed commit, or, for a
 * hob's app, at the commit GitHub made from it.
 */
export const pushReadBack =
  (api: GitHubApi["Service"], git: GitPush["Service"]): ReadBack =>
  (call) =>
    Effect.gen(function* () {
      const plan = JSON.parse(call.plan) as GitHubPushPlan;
      const [owner = "", name = ""] = plan.repository.split("/");
      const repository = { owner, name };
      const head = yield* api.branchHead(call.agentId, repository, plan.remoteBranch);
      if (head === null) return false;
      if (head === plan.commit) return true;
      const sentAs = yield* git.sentAs(plan.folder, repository, plan.commit);
      return head === sentAs && pushedText(plan, [[plan.commit, sentAs]]);
    });

/** The push tool as the hob is offered it, before the pipeline adds its key. */
const pushTool = () => {
  const tool = GITHUB_WRITE_TOOLS.find((each) => each.name === "github_push");
  if (tool === undefined) throw new Error("The GitHub Charm has no github_push tool.");
  return { ...tool, inputSchema: githubWriteToolJsonSchema("github_push") };
};

/** The GitHub Charm's Push, for the pipeline to run. */
export const makeGitHubPush = (repositoryFor: RepositoryFor) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const credential = yield* GitHubCredential;
    const git = yield* GitPush;

    const github = <A>(effect: Effect.Effect<A, GitHubError>) =>
      effect.pipe(Effect.mapError((error) => new HubRefusal({ message: error.message })));

    const checkBranch = (name: string) =>
      branchNameCheck(git, name).pipe(Effect.mapError((message) => new HubRefusal({ message })));

    /**
     * One push attempt, then once more when nothing reached GitHub, or with a refreshed token when
     * GitHub refused the sign-in (ADR 020). Refused again after the refresh, GitHub is disconnected.
     */
    const send = (
      agentId: AgentId,
      staged: StagedBranch,
      plan: GitHubPushPlan,
      repository: GitHubRepository,
      known: ReadonlyArray<string | null>,
    ): Effect.Effect<WriteOutcome> =>
      Effect.gen(function* () {
        const settings = yield* GitHubPushSettings;
        const target = {
          repository,
          commit: plan.commit,
          remoteBranch: plan.remoteBranch,
          force: plan.force,
          replaces: plan.replaces,
        };
        const viaSsh: PushTransport = { _tag: "Ssh", agentSocket: settings.agentSocket ?? process.env.SSH_AUTH_SOCK };
        // The commits GitHub made from the hob's in this push, for the hob's answer and for forgetting them.
        let sent: ReadonlyArray<readonly [string, string]> = [];
        // Why the hub has no token for the push, such as a hob's app that needs a reconnect.
        const noToken = (error: GitHubError) => ({ _tag: "NoToken", message: error.message }) as const;
        const once = Effect.gen(function* () {
          // A hob with its own app always pushes as its bot, never over the user's SSH key (ADR 022).
          // Asked on every attempt, retries included: a source other than the one the push was
          // checked under stops it rather than sending it as someone else.
          const app = yield* credential.hobApp(agentId).pipe(Effect.result);
          if (Result.isFailure(app)) return noToken(app.failure);
          const viaApp = app.success !== null;
          let over = (token: Redacted.Redacted<string> | null) =>
            git.push(staged, target, token === null ? viaSsh : { _tag: "Https", token });
          let scope: GitHubTokenScope = { repository, action: "push" };
          if (settings.over === "ssh" && !viaApp) return yield* over(null);
          if (viaApp) {
            // GitHub makes the commits as the bot first; the branch then moves to its last one with Git.
            const made = yield* recreateOnGitHub(api, git, agentId, staged, repository, known);
            if (made._tag !== "Made") return made;
            if (made.sent.length > 0) sent = made.sent;
            scope = made.scope;
            const tip = { ...staged, commit: made.tip };
            over = (token) =>
              Effect.gen(function* () {
                const https: PushTransport = { _tag: "Https", token: token ?? Redacted.make("") };
                const fetched = yield* git.record(staged, repository, made.sent, https);
                if (fetched._tag !== "Fetched") return fetched;
                return yield* git.push(tip, { ...target, commit: made.tip }, https);
              });
          }
          const token = yield* credential.tokenFor(agentId, scope).pipe(Effect.result);
          if (Result.isFailure(token)) return noToken(token.failure);
          const result = yield* over(token.success);
          if (result._tag !== "SignedOut") return result;
          const fresh = yield* credential.refused(agentId, token.success).pipe(Effect.result);
          if (Result.isFailure(fresh)) return noToken(fresh.failure);
          const again = yield* over(fresh.success);
          if (again._tag !== "SignedOut") return again;
          const why = yield* refusedTwice(credential, agentId, scope, fresh.success);
          return viaApp ? noToken(why) : again;
        });
        let result = yield* once;
        // Nothing reached GitHub, so trying once more cannot send it twice.
        if (result._tag === "NotSent") result = yield* once;
        // A refused push leaves GitHub's commits unpublished, so a later push makes them anew.
        if (result._tag === "Rejected" || result._tag === "Refused") {
          yield* git.forget(
            staged,
            repository,
            sent.map(([local]) => local),
          );
        }
        switch (result._tag) {
          case "Pushed":
            return { _tag: "Applied", text: pushedText(plan, sent) };
          case "Rejected":
            return { _tag: "Refused", text: result.message };
          case "Refused":
            return { _tag: "Refused", text: `${result.message} Nothing was pushed.` };
          case "Unpublished":
            return {
              _tag: "NotSent",
              text: `${result.message} No branch was changed, but what the hub already made on GitHub may stay there, unpublished, until GitHub cleans it up. You may try again.`,
            };
          case "NotSent":
            return { _tag: "NotSent", text: `${result.message} You may try again.` };
          case "SignedOut":
            return {
              _tag: "NotSent",
              text:
                settings.over === "ssh"
                  ? "GitHub refused the SSH login, so nothing was pushed. Ask the user to check their SSH agent."
                  : "GitHub refused the hub's sign-in, so nothing was pushed. Ask the user to connect GitHub again in Settings › Charms.",
            };
          case "Uncertain":
            return { _tag: "Uncertain", text: result.message };
          case "NoToken":
            return { _tag: "NotSent", text: `${result.message} Nothing was pushed.` };
        }
      });

    /**
     * The commits a push adds beyond `known`. A hob's app also counts the commits it already sent as
     * GitHub's, under the IDs GitHub gave them, and gives GitHub's commit for the pushed one.
     */
    const newCommits = (
      staged: StagedBranch,
      known: ReadonlyArray<string | null>,
      app: { readonly folder: string; readonly repository: GitHubRepository } | null,
    ) =>
      app === null
        ? Effect.map(git.commits(staged, known), (commits) => ({ commits, sentAs: null }))
        : Effect.all({
            commits: git.commits(staged, known, app.repository),
            sentAs: git.sentAs(app.folder, app.repository, staged.commit),
          });

    /** Sends under the sign-in the card named: another account never pushes it (ADR 020). */
    const sendPinned = (agentId: AgentId, repository: GitHubRepository, push: Effect.Effect<WriteOutcome>) =>
      credential
        .onRepository(agentId, repository, push)
        .pipe(
          Effect.catch((error) =>
            Effect.succeed<WriteOutcome>({ _tag: "NotSent", text: `${error.message} Nothing was pushed.` }),
          ),
        );

    /**
     * Plans pushing a hob's branch from the hob's folder's repository. The branch is staged for the
     * whole call, and its staging ref is removed once the call has ended.
     */
    const planPush = (input: GitHubWriteInput<"github_push">, { turn, access }: HubPlanContext) =>
      Effect.gen(function* () {
        const remoteBranch = input.remote_branch ?? input.branch;
        yield* checkBranch(input.branch);
        yield* checkBranch(remoteBranch);
        const { folder, repository } = yield* repositoryFor(access, input.folder);
        const staged = yield* git
          .stage(access.folders, folder, input.branch)
          .pipe(Effect.mapError((error) => new HubRefusal({ message: error.message })));
        const slug = repositorySlug(repository);
        const agentId = turn.agentId;
        // One sign-in from planning to sending (ADR 020): the card names the account that pushes, so
        // if the user connects another account while the card waits, the push does not run under it,
        // and calling again asks again. The app's sign-in also reads public repositories it is not
        // installed on, so the hub reads and pushes only where the hob's sign-in reaches.
        return yield* pinnedPlan(
          credential,
          agentId,
          repository,
          Effect.gen(function* () {
            const info = yield* github(api.repository(agentId, repository));
            const replaces = yield* github(api.branchHead(agentId, repository, remoteBranch));
            const defaultHead =
              info.defaultBranch === remoteBranch
                ? replaces
                : yield* github(api.branchHead(agentId, repository, info.defaultBranch));
            const actingAs = yield* github(githubActor(credential, api, agentId));
            const { commits, sentAs } = yield* newCommits(
              staged,
              [replaces, defaultHead],
              actingAs._tag === "HobApp" ? { folder, repository } : null,
            );
            const settings = yield* GitHubPushSettings;
            const plan: GitHubPushPlan = {
              repository: slug,
              folder,
              branch: input.branch,
              remoteBranch,
              commit: staged.commit,
              force: input.force === true,
              replaces,
              defaultBranch: info.defaultBranch,
              toDefaultBranch: remoteBranch === info.defaultBranch,
              commits: commits.count,
              subjects: commits.subjects,
              actingAs,
              over: settings.over,
            };
            if (alreadyThere(replaces, staged.commit, sentAs)) {
              return {
                _tag: "NoCall",
                text: `${plan.repository} branch ${remoteBranch} is already at ${short(staged.commit)}, so there was nothing to push.`,
              } as const;
            }
            // A new branch with no commit GitHub lacks only names a commit GitHub has, such as the default
            // branch's after a hob's own commit was refused (#1219), so no card offers it as a push.
            if (replaces === null && commits.count === 0) {
              return yield* new HubRefusal({ message: noNewCommits(plan) });
            }
            const request: PolicyRequest = {
              _tag: "Push",
              remote: `github.com/${slug}`,
              branch: remoteBranch,
              force: plan.force,
              toDefaultBranch: plan.toDefaultBranch,
              cwd: folder,
              exact: true,
            };
            return {
              request,
              card: {
                arguments: { ...plan },
                summary: githubPushSummary(plan),
                label: `Pushing ${input.branch} to GitHub`,
              },
              write: {
                site: pushSite(repository, remoteBranch),
                recorded: plan,
                appliedText: pushedText(plan),
                send: sendPinned(agentId, repository, send(agentId, staged, plan, repository, [replaces, defaultHead])),
              },
            };
          }),
        );
      });

    const action: HubAction<PolicyRequest> = hubAction({
      tool: pushTool(),
      input: GitHubWriteInputs.github_push,
      effect: "write",
      operation: "push",
      otherwise: "nothing can be pushed",
      readBack: pushReadBack(api, git),
      plan: planPush,
    });
    return action;
  });
