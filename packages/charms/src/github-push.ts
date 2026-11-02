import {
  type AskableVerdict,
  approvalNote,
  askUntilDecided,
  type CharmTurn,
  type HubCallStep,
  type ToolAccess,
} from "@hobbots/agents";
import {
  type GitHubPushPlan,
  type GitHubRepository,
  type GitHubWriteInput,
  githubPushSummary,
  repositorySlug,
} from "@hobbots/domain";
import { type PolicyContext, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Context, Data, Effect, Option } from "effect";
import type { CharmCallRunner, ReadBack, WriteOutcome } from "./charm-calls.ts";
import { GitPush, type PushResult, type PushTransport } from "./git-push.ts";
import { GitHubApi, type GitHubError, GitHubToken } from "./github-api.ts";

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
      const head = yield* api.branchHead({ owner, name }, plan.remoteBranch);
      return head === plan.commit;
    });

export const makeGitHubPush = (runner: CharmCallRunner) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const token = yield* GitHubToken;
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

    /** One push attempt, then once more when nothing reached GitHub or the sign-in was refused (ADR 020). */
    const send = (
      staged: { readonly staging: string; readonly commit: string },
      plan: GitHubPushPlan,
      repository: GitHubRepository,
    ): Effect.Effect<WriteOutcome> =>
      Effect.gen(function* () {
        const settings = yield* GitHubPushSettings;
        const transport: Effect.Effect<PushTransport, GitHubError> =
          settings.over === "ssh"
            ? Effect.succeed({ _tag: "Ssh", agentSocket: settings.agentSocket ?? process.env.SSH_AUTH_SOCK })
            : token.get.pipe(Effect.map((t) => ({ _tag: "Https", token: t }) as const));
        const once = Effect.gen(function* () {
          const how = yield* transport.pipe(Effect.option);
          if (Option.isNone(how)) return { _tag: "SignedOut" } as PushResult;
          return yield* git.push(
            staged,
            {
              repository,
              commit: plan.commit,
              remoteBranch: plan.remoteBranch,
              force: plan.force,
              replaces: plan.replaces,
            },
            how.value,
          );
        });
        let result = yield* once;
        // Nothing was done in either case, so trying once more cannot send it twice.
        if (result._tag === "NotSent" || result._tag === "SignedOut") result = yield* once;
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
                  : "GitHub refused the hub's sign-in, so nothing was pushed. Ask the user to sign in to GitHub on the hub again.",
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
        const info = yield* api.repository(repository).pipe(Effect.mapError(githubError));
        const replaces = yield* api.branchHead(repository, remoteBranch).pipe(Effect.mapError(githubError));
        const defaultHead =
          info.defaultBranch === remoteBranch
            ? replaces
            : yield* api.branchHead(repository, info.defaultBranch).pipe(Effect.mapError(githubError));
        const actingAs = yield* api.viewer.pipe(Effect.option, Effect.map(Option.getOrNull));
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
          send(staged, plan, repository),
        );
        const note = decision.approval === undefined ? "" : ` ${approvalNote(decision.approval)}`;
        if (outcome._tag === "Applied") return `${outcome.text}${note}`;
        if (outcome._tag === "Uncertain") return yield* new Refused({ message: outcome.text });
        return yield* new Refused({ message: `${outcome.text}${note}` });
      }).pipe(Effect.scoped);

    return { push, readBack: pushReadBack(api) };
  });
