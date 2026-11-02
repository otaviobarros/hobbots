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
  commentMarker,
  type GitHubCommentPlan,
  type GitHubPullRequestPlan,
  type GitHubRepository,
  type GitHubWriteInput,
  type GitHubWriteToolName,
  githubCommentSummary,
  githubPullRequestSummary,
  hasCommentMarker,
  repositorySlug,
  stripCommentMarkers,
} from "@hobbots/domain";
import { type PolicyContext, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Data, Effect, Option } from "effect";
import type { CharmCallRunner, ReadBack, WriteOutcome } from "./charm-calls.ts";
import { GitPush } from "./git-push.ts";
import { GitHubCredential } from "./github-account.ts";
import { GitHubApi, type GitHubError, type GitHubWrite } from "./github-api.ts";

/**
 * The GitHub Charm's Open pull requests and Comment on GitHub (ADR 020, #324). The hub redacts the
 * outgoing text and reads GitHub's side before it decides, so the approval card shows, and its digest
 * covers, exactly what is sent. Each write is then a recorded Charm call (#323): a retried key returns
 * the first answer, and a call that ends without a clear answer is read back on GitHub, never resent.
 */

class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

/**
 * Decides a Charm write on the folder and the hob's answers, with its live grants read again each
 * time: the hub sends it outside the sandbox, so neither the sandbox nor the model's hosts hold the rule.
 */
export const decideCharmWrite =
  (engine: PolicyEngine["Service"], turn: CharmTurn, base: ToolAccess, request: PolicyRequest) =>
  (fresh: ToolAccess | null): Effect.Effect<AskableVerdict> =>
    Effect.gen(function* () {
      const access = fresh ?? base;
      const grants = turn.approvals ? yield* turn.approvals.grants : [];
      const context: PolicyContext = { ...access.policy, sandbox: "on", modelHosts: [], grants };
      return yield* engine.decide(context, request);
    });

/** Fails with the reason when Git would not take `name` as a branch name (ADR 020). */
export const branchNameCheck = (git: GitPush["Service"], name: string): Effect.Effect<void, string> =>
  git
    .isBranchName(name)
    .pipe(Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(`${name} is not a branch name Git takes.`))));

/** GitHub's times count whole seconds, so a call is compared from the start of the second it was recorded in. */
const recordedSecond = (createdAt: string) => Math.floor(Date.parse(createdAt) / 1000) * 1000;

const ownerAndName = (slug: string): GitHubRepository => {
  const [owner = "", name = ""] = slug.split("/");
  return { owner, name };
};

/** What the hob is told about an opened pull request. */
const openedText = (plan: GitHubPullRequestPlan, number: number, url: string) =>
  `Opened ${plan.draft ? "draft " : ""}pull request #${number} from ${plan.head} into ${plan.base} in ${plan.repository}: ${url}`;

/** What the hob is told about a posted comment. */
const commentedText = (plan: GitHubCommentPlan, url: string) =>
  `Commented on ${plan.pullRequest ? "pull request" : "issue"} #${plan.number} in ${plan.repository}: ${url}`;

/** A comment's plan as recorded: the card's plan and the hub's marker nonce, which the hob never sees. */
interface RecordedCommentPlan extends GitHubCommentPlan {
  readonly marker: string;
}

/**
 * Reads opening a pull request back (ADR 020): it took effect when a pull request in any state from
 * that head into that base was opened by the acting account after the call was recorded. An older
 * one from the same head is never taken for it.
 */
export const pullRequestReadBack =
  (api: GitHubApi["Service"]): ReadBack =>
  (call) =>
    Effect.gen(function* () {
      const plan = JSON.parse(call.plan) as GitHubPullRequestPlan;
      const repository = ownerAndName(plan.repository);
      const actingAs = plan.actingAs ?? (yield* api.viewer(call.agentId));
      const since = recordedSecond(call.createdAt);
      const list = yield* api.pullRequests(call.agentId, repository, plan.head, plan.base);
      const found = list.find((pr) => pr.author === actingAs && Date.parse(pr.createdAt) >= since);
      return found === undefined ? false : openedText(plan, found.number, found.url);
    });

/**
 * Reads a comment back (ADR 020): it took effect when a comment by the acting account on that item
 * carries this call's hidden marker.
 */
export const commentReadBack =
  (api: GitHubApi["Service"]): ReadBack =>
  (call) =>
    Effect.gen(function* () {
      const plan = JSON.parse(call.plan) as RecordedCommentPlan;
      const repository = ownerAndName(plan.repository);
      const actingAs = plan.actingAs ?? (yield* api.viewer(call.agentId));
      const since = new Date(recordedSecond(call.createdAt)).toISOString();
      const marker = commentMarker(plan.marker);
      const comments = yield* api.commentsSince(call.agentId, repository, plan.number, since);
      const found = comments.find((comment) => comment.author === actingAs && comment.body.includes(marker));
      return found === undefined ? false : commentedText(plan, found.url);
    });

/** A GitHub write's answer as the hob is told it; `applied` words a write GitHub took. */
const outcomeOf = <A>(result: GitHubWrite<A>, applied: (value: A) => string): WriteOutcome => {
  switch (result._tag) {
    case "Done":
      return { _tag: "Applied", text: applied(result.value) };
    case "Refused":
      return { _tag: "Refused", text: result.message };
    case "NotSent":
      return { _tag: "NotSent", text: `${result.message} You may try again.` };
    case "RateLimited":
      return { _tag: "NotSent", text: result.message };
    case "SignedOut":
      return { _tag: "NotSent", text: "GitHub refused the hub's sign-in, so nothing was sent." };
    case "Uncertain":
      return { _tag: "Uncertain", text: result.message };
  }
};

/** What the hob is told when redaction changed what it wrote. */
const redactedNote = (parts: ReadonlyArray<string>) =>
  parts.length === 0
    ? ""
    : ` Hobbots redacted what looked like secrets from the ${parts.join(" and ")} before deciding, so the user approved, and GitHub got, the redacted text.`;

export const makeGitHubWrites = (runner: CharmCallRunner) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const credential = yield* GitHubCredential;
    const git = yield* GitPush;
    const engine = yield* PolicyEngine;

    const github = <A>(effect: Effect.Effect<A, GitHubError>) =>
      effect.pipe(Effect.mapError((error) => new Refused({ message: error.message })));

    const checkBranch = (name: string) =>
      branchNameCheck(git, name).pipe(Effect.mapError((message) => new Refused({ message })));

    /** One request, then once more when nothing reached GitHub, which cannot send it twice. */
    const sendOnceMore = <A>(send: Effect.Effect<GitHubWrite<A>>) =>
      Effect.flatMap(send, (first) => (first._tag === "NotSent" ? send : Effect.succeed(first)));

    interface Planned<P extends object> {
      readonly tool: Exclude<GitHubWriteToolName, "github_push">;
      readonly key: string;
      readonly input: unknown;
      readonly site: string;
      /** What the card shows and its digest covers. */
      readonly plan: P;
      readonly summary: string;
      /** What the call's record keeps beyond the card's plan, never shown to the hob. */
      readonly recorded?: object;
      readonly appliedText: string;
      readonly label: string;
      readonly request: PolicyRequest;
      readonly send: Effect.Effect<WriteOutcome>;
      readonly note: string;
    }

    /** Asks when the policy says so, then sends the write as a recorded Charm call under the pinned sign-in. */
    const decideAndSend = <P extends object>(
      turn: CharmTurn,
      access: ToolAccess,
      repository: GitHubRepository,
      step: HubCallStep | undefined,
      planned: Planned<P>,
    ) =>
      Effect.gen(function* () {
        // A call without a step has no card to show, so it cannot ask.
        const decision = yield* askUntilDecided({
          call: {
            id: step?.id ?? planned.key,
            tool: planned.tool,
            arguments: { ...planned.plan, summary: planned.summary },
            label: planned.label,
          },
          approvals: step === undefined ? null : turn.approvals,
          decide: decideCharmWrite(engine, turn, access, planned.request),
          report: step?.report ?? (() => {}),
          unknown: "Hobbots cannot decide this call.",
        });
        if (decision._tag === "Refuse") return yield* new Refused({ message: decision.reason });
        step?.report({
          _tag: "ToolStarted",
          id: step.id,
          tool: planned.tool,
          operation: decision.verdict.operation,
          targets: decision.verdict.targets,
          label: planned.label,
        });
        const outcome = yield* runner.run(
          {
            agentId: turn.agentId,
            tool: planned.tool,
            key: planned.key,
            input: planned.input,
            site: planned.site,
            plan: { ...planned.plan, ...planned.recorded },
            appliedText: planned.appliedText,
            step,
            threadId: turn.threadId,
            messageId: turn.messageId,
          },
          // The approval is bound to the sign-in its card named: another account never sends it.
          credential
            .onRepository(turn.agentId, repository, planned.send)
            .pipe(
              Effect.catch((error) =>
                Effect.succeed<WriteOutcome>({ _tag: "NotSent", text: `${error.message} Nothing was sent.` }),
              ),
            ),
        );
        const approved = decision.approval === undefined ? "" : ` ${approvalNote(decision.approval)}`;
        if (outcome._tag === "Applied") return `${outcome.text}${planned.note}${approved}`;
        if (outcome._tag === "Uncertain") return yield* new Refused({ message: outcome.text });
        return yield* new Refused({ message: `${outcome.text}${planned.note}${approved}` });
      });

    /** Runs `use` under one sign-in from planning to sending (ADR 020), as Push does. */
    const pinned = <A, R>(
      agentId: AgentId,
      repository: GitHubRepository,
      use: Effect.Effect<A, Refused | GitHubError, R>,
    ) =>
      credential
        .onRepository(agentId, repository, use)
        .pipe(Effect.mapError((error) => (error instanceof Refused ? error : new Refused({ message: error.message }))));

    /** Opens a pull request from a pushed branch: `folder` and `repository` are the hob's, resolved by the caller. */
    const openPullRequest = (
      turn: CharmTurn,
      access: ToolAccess,
      folder: string,
      repository: GitHubRepository,
      input: GitHubWriteInput<"github_open_pull_request">,
      step: HubCallStep | undefined,
    ): Effect.Effect<string, Refused> =>
      Effect.gen(function* () {
        const { key, ...withoutKey } = input;
        yield* checkBranch(input.head);
        if (input.base !== undefined) yield* checkBranch(input.base);
        const earlier = yield* runner.earlier(turn.agentId, key, withoutKey);
        if (Option.isSome(earlier)) return earlier.value;

        // Outgoing text is redacted before deciding, so the card shows and approves what is sent.
        const title = turn.redactor.text(input.title);
        const body = turn.redactor.text(input.body ?? "");
        const redacted = [
          ...(title === input.title ? [] : ["title"]),
          ...(body === (input.body ?? "") ? [] : ["description"]),
        ];
        const slug = repositorySlug(repository);
        const agentId = turn.agentId;
        return yield* pinned(
          agentId,
          repository,
          Effect.gen(function* () {
            const info = yield* github(api.repository(agentId, repository));
            const base = input.base ?? info.defaultBranch;
            if (base === input.head) {
              return yield* new Refused({ message: `A pull request needs a head branch other than ${base}.` });
            }
            const head = yield* github(api.branchHead(agentId, repository, input.head));
            if (head === null) {
              return yield* new Refused({
                message: `${slug} has no branch ${input.head} on GitHub. Push it with github_push first.`,
              });
            }
            const actingAs = yield* api.viewer(agentId).pipe(Effect.option, Effect.map(Option.getOrNull));
            const plan: GitHubPullRequestPlan = {
              repository: slug,
              folder,
              head: input.head,
              base,
              title,
              body,
              draft: input.draft !== false,
              actingAs,
            };
            return yield* decideAndSend(turn, access, repository, step, {
              tool: "github_open_pull_request",
              key,
              input: withoutKey,
              site: `github.com/${slug} pull ${input.head} into ${base}`,
              plan,
              summary: githubPullRequestSummary(plan),
              appliedText: `Opened a pull request from ${plan.head} into ${plan.base} in ${slug}.`,
              label: `Opening a pull request from ${input.head}`,
              request: { _tag: "PullRequest", folder, repository: slug, base },
              send: sendOnceMore(
                api.openPullRequest(agentId, repository, {
                  head: plan.head,
                  base: plan.base,
                  title: plan.title,
                  body: plan.body,
                  draft: plan.draft,
                }),
              ).pipe(Effect.map((result) => outcomeOf(result, (pr) => openedText(plan, pr.number, pr.url)))),
              note: redactedNote(redacted),
            });
          }),
        );
      }).pipe(Effect.scoped);

    /** Comments on an issue or pull request: `folder` and `repository` are the hob's, resolved by the caller. */
    const comment = (
      turn: CharmTurn,
      access: ToolAccess,
      folder: string,
      repository: GitHubRepository,
      input: GitHubWriteInput<"github_comment">,
      step: HubCallStep | undefined,
    ): Effect.Effect<string, Refused> =>
      Effect.gen(function* () {
        const { key, ...withoutKey } = input;
        const earlier = yield* runner.earlier(turn.agentId, key, withoutKey);
        if (Option.isSome(earlier)) return earlier.value;

        // The hub's marker is its own: anything shaped like one goes before the text is redacted and shown.
        const unmarked = stripCommentMarkers(input.body);
        const body = turn.redactor.text(unmarked);
        if (hasCommentMarker(body)) {
          return yield* new Refused({
            message:
              "Your comment holds text shaped like Hobbots' hidden call marker (`<!-- hobbots-call`), which Hobbots keeps for itself. Write it without that.",
          });
        }
        if (body.trim() === "") {
          return yield* new Refused({ message: "Your comment is empty once Hobbots' hidden markers are taken out." });
        }
        const notes = [
          ...(unmarked === input.body
            ? []
            : [" Hobbots took out text shaped like its hidden call marker, which it keeps for itself."]),
          redactedNote(body === unmarked ? [] : ["comment"]),
        ].join("");
        const slug = repositorySlug(repository);
        const agentId = turn.agentId;
        return yield* pinned(
          agentId,
          repository,
          Effect.gen(function* () {
            const item = yield* github(api.item(agentId, repository, input.number, 0));
            const actingAs = yield* api.viewer(agentId).pipe(Effect.option, Effect.map(Option.getOrNull));
            const plan: GitHubCommentPlan = {
              repository: slug,
              folder,
              number: input.number,
              pullRequest: item.pullRequest,
              itemTitle: item.title,
              body,
              actingAs,
            };
            // Random per call and never shown to the hob, so no comment it writes can pass for this call's.
            const marker = crypto.randomUUID();
            return yield* decideAndSend(turn, access, repository, step, {
              tool: "github_comment",
              key,
              input: withoutKey,
              site: `github.com/${slug} #${input.number}`,
              plan,
              summary: githubCommentSummary(plan),
              recorded: { marker },
              appliedText: `Commented on #${input.number} in ${slug}.`,
              label: `Commenting on #${input.number}`,
              request: { _tag: "GitHubComment", folder, repository: slug, number: input.number },
              send: sendOnceMore(
                api.comment(agentId, repository, input.number, `${body}\n\n${commentMarker(marker)}`),
              ).pipe(Effect.map((result) => outcomeOf(result, (posted) => commentedText(plan, posted.url)))),
              note: notes,
            });
          }),
        );
      }).pipe(Effect.scoped);

    return {
      openPullRequest,
      comment,
      pullRequestReadBack: pullRequestReadBack(api),
      commentReadBack: commentReadBack(api),
    };
  });
