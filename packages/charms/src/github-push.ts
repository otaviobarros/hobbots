import {
  type AskableVerdict,
  approvalNote,
  askUntilDecided,
  type CharmTurn,
  type HubCallStep,
  type ToolAccess,
} from "@hobbots/agents";
import {
  type AgentId,
  type GitHubPushPlan,
  type GitHubRepository,
  type GitHubWriteInput,
  githubPushSummary,
  repositorySlug,
} from "@hobbots/domain";
import { type PolicyContext, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Context, Data, Effect, Option, type Redacted } from "effect";
import type { CharmCallRunner, ReadBack, WriteOutcome } from "./charm-calls.ts";
import { GitPush, type PushResult, type PushTransport } from "./git-push.ts";
import { GitHubCredential } from "./github-account.ts";
import { GitHubApi, type GitHubError } from "./github-api.ts";

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

/** What the hob is told when a push took effect. */
const pushedText = (plan: GitHubPushPlan) =>
  `Pushed ${short(plan.commit)} to ${plan.repository} branch ${plan.remoteBranch}. Its commits are on GitHub now: https://github.com/${plan.repository}/tree/${plan.remoteBranch}`;

/** Reads a push back: it took effect when the branch on GitHub is at the pushed commit. */
export const pushReadBack =
  (api: GitHubApi["Service"]): ReadBack =>
  (call) =>
    Effect.gen(function* () {
      const plan = JSON.parse(call.plan) as GitHubPushPlan;
      const [owner = "", name = ""] = plan.repository.split("/");
      const head = yield* api.branchHead(call.agentId, { owner, name }, plan.remoteBranch);
      return head === plan.commit;
    });

export const makeGitHubPush = (runner: CharmCallRunner) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const credential = yield* GitHubCredential;
    const git = yield* GitPush;
    const engine = yield* PolicyEngine;

    const githubError = (error: GitHubError) => new Refused({ message: error.message });

    const checkBranch = (name: string) =>
      git
        .isBranchName(name)
        .pipe(
          Effect.flatMap((ok) =>
            ok ? Effect.void : Effect.fail(new Refused({ message: `${name} is not a branch name Git takes.` })),
          ),
        );

    /**
     * One push attempt, then once more when nothing reached GitHub, or with a refreshed token when
     * GitHub refused the sign-in (ADR 020). Refused again after the refresh, GitHub is disconnected.
     */
    const send = (
      agentId: AgentId,
      staged: { readonly staging: string; readonly commit: string },
      plan: GitHubPushPlan,
      repository: GitHubRepository,
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
        const over = (token: Redacted.Redacted<string> | null) =>
          git.push(staged, target, token === null ? viaSsh : { _tag: "Https", token });
        const signedOut = { _tag: "SignedOut" } as PushResult;
        const once = Effect.gen(function* () {
          if (settings.over === "ssh") return yield* over(null);
          const token = yield* credential.tokenFor(agentId).pipe(Effect.option);
          if (Option.isNone(token)) return signedOut;
          const result = yield* over(token.value);
          if (result._tag !== "SignedOut") return result;
          const fresh = yield* credential.refused(agentId, token.value).pipe(Effect.option);
          if (Option.isNone(fresh)) return signedOut;
          const again = yield* over(fresh.value);
          if (again._tag === "SignedOut") yield* credential.revoked(fresh.value);
          return again;
        });
        let result = yield* once;
        // Nothing reached GitHub, so trying once more cannot send it twice.
        if (result._tag === "NotSent") result = yield* once;
        switch (result._tag) {
          case "Pushed":
            return { _tag: "Applied", text: pushedText(plan) };
          case "Rejected":
            return { _tag: "Refused", text: result.message };
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
        }
      });

    const decide = (
      turn: CharmTurn,
      base: ToolAccess,
      request: PolicyRequest,
    ): ((access: ToolAccess | null) => Effect.Effect<AskableVerdict>) => {
      return (fresh) =>
        Effect.gen(function* () {
          const access = fresh ?? base;
          const grants = turn.approvals ? yield* turn.approvals.grants : [];
          // The engine decides a push on the folder and the hob's answers: the hub pushes outside the sandbox.
          const context: PolicyContext = { ...access.policy, sandbox: "on", modelHosts: [], grants };
          return yield* engine.decide(context, request);
        });
    };

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
        const earlier = yield* runner.earlier(turn.agentId, key, withoutKey);
        if (Option.isSome(earlier)) return earlier.value;

        const staged = yield* git
          .stage(access.folders, folder, input.branch)
          .pipe(Effect.mapError((error) => new Refused({ message: error.message })));
        const slug = repositorySlug(repository);
        const agentId = turn.agentId;
        // The app's sign-in also reads public repositories it is not installed on (ADR 020): the
        // hub reads and pushes only where the hob's sign-in reaches.
        const github = <A>(effect: Effect.Effect<A, GitHubError>) =>
          credential.onRepository(agentId, repository, effect).pipe(Effect.mapError(githubError));
        const info = yield* github(api.repository(agentId, repository));
        const replaces = yield* github(api.branchHead(agentId, repository, remoteBranch));
        const defaultHead =
          info.defaultBranch === remoteBranch
            ? replaces
            : yield* github(api.branchHead(agentId, repository, info.defaultBranch));
        const actingAs = yield* api.viewer(agentId).pipe(Effect.option, Effect.map(Option.getOrNull));
        const commits = yield* git.commits(staged, [replaces, defaultHead]);
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
        if (replaces === staged.commit) {
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
          decide: decide(turn, access, request),
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
            .onRepository(agentId, repository, send(agentId, staged, plan, repository))
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
      }).pipe(Effect.scoped);

    return { push, readBack: pushReadBack(api) };
  });
