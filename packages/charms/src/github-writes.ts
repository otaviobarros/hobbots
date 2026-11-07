import {
  type HubAction,
  type HubPlanContext,
  HubRefusal,
  type HubWritePlan,
  hubAction,
  type ReadBack,
  type ToolAccess,
  type WriteOutcome,
} from "@hobbots/agents";
import {
  type AgentId,
  commentMarker,
  GITHUB_WRITE_TOOLS,
  type GitHubCommentPlan,
  type GitHubPullRequestPlan,
  type GitHubRepository,
  type GitHubWriteInput,
  GitHubWriteInputs,
  githubActorText,
  githubCommentSummary,
  githubPullRequestSummary,
  githubWriteToolJsonSchema,
  hasCommentMarker,
  repositorySlug,
  stripCommentMarkers,
} from "@hobbots/domain";
import type { PolicyRequest } from "@hobbots/permissions";
import { Context, Effect } from "effect";
import { GitPush } from "./git-push.ts";
import { GitHubCredential } from "./github-account.ts";
import { githubActor, recordedLogin } from "./github-actor.ts";
import { GitHubApi, type GitHubError, type GitHubWrite } from "./github-api.ts";
import { GITHUB_CHARM } from "./github-operations.ts";

/**
 * The GitHub Charm's Open pull requests and Comment on GitHub (ADR 020, #324), as hub actions (ADR
 * 031). Each only plans its call: it reads GitHub's side under one sign-in and builds the request, the
 * card, what the call's record keeps and the send, and the hub action pipeline decides, asks, records
 * and sends it. The pipeline hands the plan the hob's input redacted, so the approval card shows, and
 * its digest covers, exactly what is sent. Each write is a recorded Charm call (#323): a retried key
 * returns the first answer, and a call that ends without a clear answer is read back on GitHub, never
 * resent.
 */

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

/** A pull request's plan as recorded: the card's plan and the pull requests already there when deciding. */
interface RecordedPullRequestPlan extends GitHubPullRequestPlan {
  readonly existing?: ReadonlyArray<number>;
}

/** How far before the call reading a comment back looks, so a clock behind GitHub's never misses it. */
const COMMENT_MARGIN_MS = 10 * 60 * 1000;

/** A comment's plan as recorded: the card's plan and the hub's marker nonce, which the hob never sees. */
interface RecordedCommentPlan extends GitHubCommentPlan {
  readonly marker: string;
}

/**
 * Reads opening a pull request back (ADR 020): it took effect when a pull request in any state from
 * that head into that base was opened by the acting account after the call was recorded. An older
 * one from the same head is never taken for it: those GitHub listed when deciding are left out by
 * number, so a hub clock behind GitHub's cannot mistake one for this call's. A hob acting as the
 * user's account shares it, so one the user opens there meanwhile counts as this call's; a hob's own
 * app's bot is its alone (ADR 022).
 */
export const pullRequestReadBack =
  (api: GitHubApi["Service"]): ReadBack =>
  (call) =>
    Effect.gen(function* () {
      const plan = JSON.parse(call.plan) as RecordedPullRequestPlan;
      const existing = new Set(plan.existing ?? []);
      const repository = ownerAndName(plan.repository);
      const actingAs = recordedLogin(plan.actingAs) ?? (yield* api.viewer(call.agentId));
      const since = recordedSecond(call.createdAt);
      const list = yield* api.pullRequests(call.agentId, repository, plan.head, plan.base);
      const found = list.find(
        (pr) => !existing.has(pr.number) && pr.author === actingAs && Date.parse(pr.createdAt) >= since,
      );
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
      const actingAs = recordedLogin(plan.actingAs) ?? (yield* api.viewer(call.agentId));
      // The nonce alone identifies this call's comment, so the time only narrows how much is read.
      const since = new Date(recordedSecond(call.createdAt) - COMMENT_MARGIN_MS).toISOString();
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

/** What the hob is told when redaction changed what it wrote, by the words for each part. */
const redactedNote = (parts: ReadonlyArray<string>) =>
  parts.length === 0
    ? ""
    : ` Hobbots redacted what looked like secrets from the ${parts.join(" and ")} before deciding, so the user approved, and GitHub got, the redacted text.`;

/** The folder a write acts from and its repository, resolved from the hob's own folders as for a read. */
export type RepositoryFor = (
  access: ToolAccess,
  named: string | undefined,
) => Effect.Effect<{ readonly folder: string; readonly repository: GitHubRepository }, HubRefusal>;

/** A write tool as the hob is offered it, before the pipeline adds its key. */
const writeTool = (name: "github_open_pull_request" | "github_comment") => {
  const tool = GITHUB_WRITE_TOOLS.find((each) => each.name === name);
  if (tool === undefined) throw new Error(`The GitHub Charm has no ${name} tool.`);
  return { ...tool, inputSchema: githubWriteToolJsonSchema(name) };
};

/** The GitHub writes the pipeline runs: opening a pull request and commenting. */
export const makeGitHubWrites = (repositoryFor: RepositoryFor) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    const credential = yield* GitHubCredential;
    const git = yield* GitPush;

    const refused = (error: GitHubError) => new HubRefusal({ message: error.message });
    const github = <A>(effect: Effect.Effect<A, GitHubError>) => effect.pipe(Effect.mapError(refused));

    const checkBranch = (name: string) =>
      branchNameCheck(git, name).pipe(Effect.mapError((message) => new HubRefusal({ message })));

    /** One request, then once more when nothing reached GitHub, which cannot send it twice. */
    const sendOnceMore = <A>(send: Effect.Effect<GitHubWrite<A>>) =>
      Effect.flatMap(send, (first) => (first._tag === "NotSent" ? send : Effect.succeed(first)));

    /**
     * Plans under one sign-in (ADR 020), as Push does: GitHub is read with it, the card names it, and
     * the rest of the call, from deciding to sending, runs pinned to it, so another account never
     * asks or sends it.
     */
    const pinned = <R extends PolicyRequest>(
      agentId: AgentId,
      repository: GitHubRepository,
      plan: Effect.Effect<Omit<HubWritePlan<R>, "pinned">, HubRefusal | GitHubError>,
    ): Effect.Effect<HubWritePlan<R>, HubRefusal> =>
      credential
        .onRepository(
          agentId,
          repository,
          Effect.gen(function* () {
            const planned = yield* plan;
            const pins = yield* Effect.context<never>();
            return {
              ...planned,
              pinned: <A, E>(rest: Effect.Effect<A, E>) =>
                Effect.updateContext(rest, (now: Context.Context<never>) => Context.merge(now, pins)),
            };
          }),
        )
        .pipe(Effect.mapError((error) => (error instanceof HubRefusal ? error : refused(error))));

    /** Sends under the sign-in the card named: another account never sends it (ADR 020). */
    const sendPinned = (agentId: AgentId, repository: GitHubRepository, send: Effect.Effect<WriteOutcome>) =>
      credential
        .onRepository(agentId, repository, send)
        .pipe(
          Effect.catch((error) =>
            Effect.succeed<WriteOutcome>({ _tag: "NotSent", text: `${error.message} Nothing was sent.` }),
          ),
        );

    /** Opens a pull request from a pushed branch of the hob's folder's repository. */
    const planPullRequest = (
      input: GitHubWriteInput<"github_open_pull_request">,
      { turn, access, redacted = [] }: HubPlanContext,
    ) =>
      Effect.gen(function* () {
        yield* checkBranch(input.head);
        if (input.base !== undefined) yield* checkBranch(input.base);
        const { folder, repository } = yield* repositoryFor(access, input.folder);
        const slug = repositorySlug(repository);
        const agentId = turn.agentId;
        return yield* pinned(
          agentId,
          repository,
          Effect.gen(function* () {
            const info = yield* github(api.repository(agentId, repository));
            const base = input.base ?? info.defaultBranch;
            if (base === input.head) {
              return yield* new HubRefusal({ message: `A pull request needs a head branch other than ${base}.` });
            }
            const head = yield* github(api.branchHead(agentId, repository, input.head));
            if (head === null) {
              return yield* new HubRefusal({
                message: `${slug} has no branch ${input.head} on GitHub. Push it with github_push first.`,
              });
            }
            const actingAs = yield* github(githubActor(credential, api, agentId));
            const existing = yield* github(api.pullRequests(agentId, repository, input.head, base));
            const plan: GitHubPullRequestPlan = {
              repository: slug,
              folder,
              head: input.head,
              base,
              title: input.title,
              body: input.body ?? "",
              draft: input.draft !== false,
              actingAs,
            };
            const request: PolicyRequest = {
              _tag: "Charm",
              charm: GITHUB_CHARM.id,
              operation: "github.open-pull-request",
              folder,
              site: { repository: slug, base },
              targets: [`github.com/${slug} into ${base}`],
            };
            return {
              request,
              card: {
                arguments: { ...plan },
                summary: githubPullRequestSummary(plan),
                label: `Opening a pull request from ${input.head} ${githubActorText(actingAs)}`,
              },
              write: {
                site: `github.com/${slug} pull ${input.head} into ${base}`,
                recorded: { ...plan, existing: existing.map((pr) => pr.number) },
                appliedText: `Opened a pull request from ${plan.head} into ${plan.base} in ${slug}.`,
                note: redactedNote([
                  ...(redacted.includes("title") ? ["title"] : []),
                  ...(redacted.includes("body") ? ["description"] : []),
                ]),
                send: sendPinned(
                  agentId,
                  repository,
                  sendOnceMore(
                    api.openPullRequest(agentId, repository, {
                      head: plan.head,
                      base: plan.base,
                      title: plan.title,
                      body: plan.body,
                      draft: plan.draft,
                    }),
                  ).pipe(Effect.map((result) => outcomeOf(result, (pr) => openedText(plan, pr.number, pr.url)))),
                ),
              },
            };
          }),
        );
      });

    /** Comments on an issue or pull request of the hob's folder's repository. */
    const planComment = (input: GitHubWriteInput<"github_comment">, { turn, access, redacted = [] }: HubPlanContext) =>
      Effect.gen(function* () {
        const { folder, repository } = yield* repositoryFor(access, input.folder);
        // The hub's marker is its own: anything shaped like one goes before the text is shown.
        const body = stripCommentMarkers(input.body);
        if (hasCommentMarker(body)) {
          return yield* new HubRefusal({
            message:
              "Your comment holds text shaped like Hobbots' hidden call marker (`<!-- hobbots-call`), which Hobbots keeps for itself. Write it without that.",
          });
        }
        if (body.trim() === "") {
          return yield* new HubRefusal({
            message: "Your comment is empty once Hobbots' hidden markers are taken out.",
          });
        }
        const note = [
          ...(body === input.body
            ? []
            : [" Hobbots took out text shaped like its hidden call marker, which it keeps for itself."]),
          redactedNote(redacted.includes("body") ? ["comment"] : []),
        ].join("");
        const slug = repositorySlug(repository);
        const agentId = turn.agentId;
        return yield* pinned(
          agentId,
          repository,
          Effect.gen(function* () {
            const item = yield* github(api.item(agentId, repository, input.number, 0));
            const actingAs = yield* github(githubActor(credential, api, agentId));
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
            const request: PolicyRequest = {
              _tag: "Charm",
              charm: GITHUB_CHARM.id,
              operation: "github.comment",
              folder,
              site: { repository: slug },
              targets: [`github.com/${slug} #${input.number}`],
            };
            return {
              request,
              card: {
                arguments: { ...plan },
                summary: githubCommentSummary(plan),
                label: `Commenting on #${input.number} ${githubActorText(actingAs)}`,
              },
              write: {
                site: `github.com/${slug} #${input.number}`,
                recorded: { ...plan, marker },
                appliedText: `Commented on #${input.number} in ${slug}.`,
                note,
                send: sendPinned(
                  agentId,
                  repository,
                  sendOnceMore(
                    api.comment(agentId, repository, input.number, `${body}\n\n${commentMarker(marker)}`),
                  ).pipe(Effect.map((result) => outcomeOf(result, (posted) => commentedText(plan, posted.url)))),
                ),
              },
            };
          }),
        );
      });

    const actions: ReadonlyArray<HubAction<PolicyRequest>> = [
      hubAction({
        tool: writeTool("github_open_pull_request"),
        input: GitHubWriteInputs.github_open_pull_request,
        effect: "write",
        otherwise: "no pull request can be opened",
        readBack: pullRequestReadBack(api),
        plan: planPullRequest,
      }),
      hubAction({
        tool: writeTool("github_comment"),
        input: GitHubWriteInputs.github_comment,
        effect: "write",
        otherwise: "nothing can be commented",
        readBack: commentReadBack(api),
        plan: planComment,
      }),
    ];
    return actions;
  });
