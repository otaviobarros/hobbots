import {
  approvalNote,
  askUntilDecided,
  type CharmCallRunner,
  type CharmTurn,
  type HubCallStep,
  type ReadBack,
  scopesOf,
  type ToolAccess,
  type WriteOutcome,
} from "@hobbots/agents";
import {
  type AgentId,
  type GitHubPushPlan,
  type GitHubRepository,
  type GitHubWriteInput,
  githubPushSummary,
  repositorySlug,
} from "@hobbots/domain";
import { decideHubCall, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Context, Data, Effect, Option, Redacted, Result } from "effect";
import { GitPush, type PushTransport, type StagedBranch } from "./git-push.ts";
import { GitHubCredential, type GitHubTokenScope, refusedTwice } from "./github-account.ts";
import { githubActor } from "./github-actor.ts";
import { GitHubApi, type GitHubError } from "./github-api.ts";
import { branchNameCheck } from "./github-writes.ts";
import { recreateOnGitHub } from "./hob-app-push.ts";

/**
 * The GitHub Charm's Push (ADR 020, #323). The hub fixes the commit the hob's branch points to and
 * reads GitHub's side before it decides, so the approval card shows, and its digest covers, exactly
 * what is sent. Under Balanced a push asks; a force push, or one to the default branch, asks once
 * only. The push is then a recorded Charm call, sent from the hub's staging repository.
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

class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

/** The site a push acts on: the repository and branch, so two pushes there never overlap while one is uncertain. */
const pushSite = (repository: GitHubRepository, branch: string) =>
  `github.com/${repositorySlug(repository)} refs/heads/${branch}`;

const short = (commit: string) => commit.slice(0, 12);

/** Whether the branch on GitHub is at the pushed commit, or at the one GitHub made from it for the hob's app. */
const alreadyThere = (replaces: string | null, commit: string, sentAs: string | null) =>
  replaces === commit || (sentAs !== null && replaces === sentAs);

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

export const makeGitHubPush = (runner: CharmCallRunner) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const credential = yield* GitHubCredential;
    const git = yield* GitPush;
    const engine = yield* PolicyEngine;

    const githubError = (error: GitHubError) => new Refused({ message: error.message });

    const checkBranch = (name: string) =>
      branchNameCheck(git, name).pipe(Effect.mapError((message) => new Refused({ message })));

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

    /** Pushes a hob's branch: `folder` and `repository` are the hob's, resolved by the caller. */
    const push = (
      turn: CharmTurn,
      access: ToolAccess,
      folder: string,
      repository: GitHubRepository,
      input: GitHubWriteInput<"github_push">,
      step: HubCallStep | undefined,
    ): Effect.Effect<string, Refused> =>
      Effect.gen(function* () {
        const { key, ...withoutKey } = input;
        const remoteBranch = input.remote_branch ?? input.branch;
        yield* checkBranch(input.branch);
        yield* checkBranch(remoteBranch);
        // A retried call returns its first answer and never asks again.
        const earlier = yield* runner.earlier(turn.agentId, scopesOf(turn), key, withoutKey);
        if (Option.isSome(earlier)) return earlier.value;

        const staged = yield* git
          .stage(access.folders, folder, input.branch)
          .pipe(Effect.mapError((error) => new Refused({ message: error.message })));
        const slug = repositorySlug(repository);
        const agentId = turn.agentId;
        const github = <A>(effect: Effect.Effect<A, GitHubError>) => effect.pipe(Effect.mapError(githubError));
        // One sign-in from planning to sending (ADR 020): the card names the account that pushes, so
        // if the user connects another account while the card waits, the push does not run under it,
        // and calling again asks again. The app's sign-in also reads public repositories it is not
        // installed on, so the hub reads and pushes only where the hob's sign-in reaches.
        const pinned = Effect.gen(function* () {
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
            return `${plan.repository} branch ${remoteBranch} is already at ${short(staged.commit)}, so there was nothing to push.`;
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
          const label = `Pushing ${input.branch} to GitHub`;
          // A call without a step has no card to show, so it cannot ask.
          const decision = yield* askUntilDecided({
            call: {
              id: step?.id ?? key,
              tool: "github_push",
              arguments: { ...plan, summary: githubPushSummary(plan) },
              label,
            },
            approvals: step === undefined ? null : turn.approvals,
            decide: decideHubCall(engine, turn.approvals, access, request),
            report: step?.report ?? (() => {}),
            unknown: "Hobbots cannot decide this push.",
          });
          if (decision._tag === "Refuse") return yield* new Refused({ message: decision.reason });
          step?.report({
            _tag: "ToolStarted",
            id: step.id,
            tool: "github_push",
            operation: decision.verdict.operation,
            targets: decision.verdict.targets,
            label,
          });
          const outcome = yield* runner.run(
            {
              agentId: turn.agentId,
              scope: turn.scope(),
              also: turn.also,
              tool: "github_push",
              key,
              input: withoutKey,
              site: pushSite(repository, remoteBranch),
              plan,
              appliedText: pushedText(plan),
              step,
              threadId: turn.threadId,
              messageId: turn.messageId,
            },
            credential
              .onRepository(agentId, repository, send(agentId, staged, plan, repository, [replaces, defaultHead]))
              .pipe(
                Effect.catch((error) =>
                  Effect.succeed<WriteOutcome>({ _tag: "NotSent", text: `${error.message} Nothing was pushed.` }),
                ),
              ),
          );
          const note = decision.approval === undefined ? "" : ` ${approvalNote(decision.approval)}`;
          if (outcome._tag === "Applied") return `${outcome.text}${note}`;
          if (outcome._tag === "Uncertain") return yield* new Refused({ message: outcome.text });
          return yield* new Refused({ message: `${outcome.text}${note}` });
        });
        return yield* credential
          .onRepository(agentId, repository, pinned)
          .pipe(Effect.mapError((error) => (error instanceof Refused ? error : githubError(error))));
      }).pipe(Effect.scoped);

    return { push, readBack: pushReadBack(api, git) };
  });
