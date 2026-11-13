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
  type CharmCall,
  commentMarker,
  GITHUB_WRITE_TOOLS,
  type GitHubActor,
  type GitHubCommentPlan,
  type GitHubIssuePlan,
  type GitHubPullRequestPlan,
  type GitHubRepository,
  type GitHubWriteInput,
  GitHubWriteInputs,
  githubActorText,
  githubCommentSummary,
  githubIssueSummary,
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
import { GitHubApi, type GitHubError, type GitHubOpenedIssue, type GitHubWrite } from "./github-api.ts";
import { GITHUB_CHARM } from "./github-operations.ts";

/**
 * The GitHub Charm's Open pull requests, Comment on GitHub (ADR 020, #324) and Open issues (#1350), as hub actions (ADR
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

/** What the hob is told about an opened issue, and where it went under its parent when it has one. */
const issueText = (plan: GitHubIssuePlan, issue: Pick<GitHubOpenedIssue, "number" | "url">, attached: string) =>
  `Opened ${plan.parent === null ? "issue" : "sub-issue"} #${issue.number} in ${plan.repository}: ${issue.url}${attached}`;

/** What the hob is told about the parent when it asked for one. */
const parentText = (plan: GitHubIssuePlan, attached: boolean, why = "") =>
  plan.parent === null
    ? ""
    : attached
      ? `\nIt is a sub-issue of #${plan.parent.number}.`
      : `\nIt is not under #${plan.parent.number}: ${why === "" ? "GitHub did not attach it." : why} Tell the user, who can attach it on GitHub. Do not open it again.`;

/** An issue's plan as recorded: the card's plan and the hub's marker nonce, which the hob never sees. */
interface RecordedIssuePlan extends GitHubIssuePlan {
  readonly marker: string;
}

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
 * What reading back a marked write starts from: its recorded plan, its repository, the account it
 * acted as, the marker, and how far back to read. The nonce alone identifies the call's write, so
 * the time only narrows how much is read.
 */
const markedReadBack = <
  P extends { readonly repository: string; readonly actingAs: GitHubActor; readonly marker: string },
>(
  api: GitHubApi["Service"],
  call: CharmCall,
) =>
  Effect.gen(function* () {
    const plan = JSON.parse(call.plan) as P;
    return {
      plan,
      repository: ownerAndName(plan.repository),
      actingAs: recordedLogin(plan.actingAs) ?? (yield* api.viewer(call.agentId)),
      since: new Date(recordedSecond(call.createdAt) - COMMENT_MARGIN_MS).toISOString(),
      marker: commentMarker(plan.marker),
    };
  });

/**
 * Reads a comment back (ADR 020): it took effect when a comment by the acting account on that item
 * carries this call's hidden marker.
 */
export const commentReadBack =
  (api: GitHubApi["Service"]): ReadBack =>
  (call) =>
    Effect.gen(function* () {
      const { plan, repository, actingAs, since, marker } = yield* markedReadBack<RecordedCommentPlan>(api, call);
      const comments = yield* api.commentsSince(call.agentId, repository, plan.number, since);
      const found = comments.find((comment) => comment.author === actingAs && comment.body.includes(marker));
      return found === undefined ? false : commentedText(plan, found.url);
    });

/**
 * Reads opening an issue back (#1350): it took effect when an issue by the acting account carries
 * this call's hidden marker. Under a parent, GitHub's sub-issues of the parent then say whether the
 * second step attached it; an issue that is there but not attached still took effect, and the hob is
 * told so, since sending again would open a second issue.
 */
export const issueReadBack =
  (api: GitHubApi["Service"]): ReadBack =>
  (call) =>
    Effect.gen(function* () {
      const { plan, repository, actingAs, since, marker } = yield* markedReadBack<RecordedIssuePlan>(api, call);
      const issues = yield* api.issuesSince(call.agentId, repository, since);
      const found = issues.find((issue) => issue.author === actingAs && issue.body.includes(marker));
      if (found === undefined) return false;
      if (plan.parent === null) return issueText(plan, found, "");
      const under = yield* api.subIssues(call.agentId, repository, plan.parent.number);
      return issueText(plan, found, parentText(plan, under.includes(found.number)));
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

/**
 * Plans under one sign-in (ADR 020): GitHub is read with it, the card names it, and the rest of the
 * call, from deciding to sending, runs pinned to it, so another account never asks or sends it.
 */
export const pinnedPlan = <P extends object, R>(
  credential: GitHubCredential["Service"],
  agentId: AgentId,
  repository: GitHubRepository,
  plan: Effect.Effect<P, HubRefusal | GitHubError, R>,
): Effect.Effect<P & Pick<HubWritePlan<PolicyRequest>, "pinned">, HubRefusal, R> =>
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
    .pipe(
      Effect.mapError((error) => (error instanceof HubRefusal ? error : new HubRefusal({ message: error.message }))),
    );

/**
 * A body the hub ends with its marker, as the hob wrote it: anything shaped like the marker goes before
 * the text is shown, and what is left is redacted again, since taking one out can join a secret back
 * together (ADR 020). `what` names the body in the hob's words, such as "comment".
 */
const markableBody = (
  written: string,
  { redacted = [], redact = (text) => text }: HubPlanContext,
  what: string,
  empty: "refuse" | "allow",
): Effect.Effect<{ readonly body: string; readonly note: string }, HubRefusal> =>
  Effect.gen(function* () {
    const unmarked = stripCommentMarkers(written);
    const body = redact(unmarked);
    if (hasCommentMarker(body)) {
      return yield* new HubRefusal({
        message: `Your ${what} holds text shaped like Hobbots' hidden call marker (\`<!-- hobbots-call\`), which Hobbots keeps for itself. Write it without that.`,
      });
    }
    if (empty === "refuse" && body.trim() === "") {
      return yield* new HubRefusal({ message: `Your ${what} is empty once Hobbots' hidden markers are taken out.` });
    }
    const note = [
      ...(unmarked === written
        ? []
        : [" Hobbots took out text shaped like its hidden call marker, which it keeps for itself."]),
      redactedNote(redacted.includes("body") || body !== unmarked ? [what] : []),
    ].join("");
    return { body, note };
  });

/** The folder a write acts from and its repository, resolved from the hob's own folders as for a read. */
export type RepositoryFor = (
  access: ToolAccess,
  named: string | undefined,
) => Effect.Effect<{ readonly folder: string; readonly repository: GitHubRepository }, HubRefusal>;

/** A write tool as the hob is offered it, before the pipeline adds its key. */
const writeTool = (name: "github_open_pull_request" | "github_comment" | "github_open_issue") => {
  const tool = GITHUB_WRITE_TOOLS.find((each) => each.name === name);
  if (tool === undefined) throw new Error(`The GitHub Charm has no ${name} tool.`);
  return { ...tool, inputSchema: githubWriteToolJsonSchema(name) };
};

/** The GitHub writes the pipeline runs: opening a pull request, commenting and opening an issue. */
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

    const pinned = <R extends PolicyRequest>(
      agentId: AgentId,
      repository: GitHubRepository,
      plan: Effect.Effect<Omit<HubWritePlan<R>, "pinned">, HubRefusal | GitHubError>,
    ) => pinnedPlan(credential, agentId, repository, plan);

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
    const planComment = (input: GitHubWriteInput<"github_comment">, context: HubPlanContext) =>
      Effect.gen(function* () {
        const { turn, access } = context;
        const { folder, repository } = yield* repositoryFor(access, input.folder);
        // The hub's marker is its own (ADR 020).
        const { body, note } = yield* markableBody(input.body, context, "comment", "refuse");
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

    /** The labels as GitHub names them; one the repository does not have is refused before the card. */
    const labelsOf = (agentId: AgentId, repository: GitHubRepository, wanted: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const names: Array<string> = [];
        for (const name of new Set(wanted)) {
          const found = yield* github(api.label(agentId, repository, name));
          if (found === null) {
            return yield* new HubRefusal({
              message: `${repositorySlug(repository)} has no label "${name}", so no issue was opened. Leave it out, or ask the user to add it on GitHub first.`,
            });
          }
          if (!names.includes(found)) names.push(found);
        }
        return names;
      });

    /** The issue an issue opens under: one of the repository's issues, never a pull request. */
    const parentOf = (agentId: AgentId, repository: GitHubRepository, number: number) =>
      Effect.gen(function* () {
        const item = yield* github(api.item(agentId, repository, number, 0));
        if (item.pullRequest) {
          return yield* new HubRefusal({
            message: `#${number} in ${repositorySlug(repository)} is a pull request; a sub-issue goes under an issue.`,
          });
        }
        return { number, title: item.title };
      });

    /**
     * Opens the issue, then, under a parent, attaches it as a sub-issue as the second step of the same
     * call. The issue stands once GitHub opened it: a second step GitHub refused or never got is told,
     * and only one whose answer was lost leaves the call uncertain, for reading back.
     */
    const sendIssue = (agentId: AgentId, repository: GitHubRepository, plan: GitHubIssuePlan, marker: string) =>
      Effect.gen(function* () {
        const opened = yield* sendOnceMore(
          api.openIssue(agentId, repository, {
            title: plan.title,
            body: plan.body === "" ? commentMarker(marker) : `${plan.body}\n\n${commentMarker(marker)}`,
            labels: plan.labels,
          }),
        );
        if (opened._tag !== "Done" || plan.parent === null) {
          return outcomeOf(opened, (issue) => issueText(plan, issue, ""));
        }
        const issue = opened.value;
        const attached = yield* sendOnceMore(api.addSubIssue(agentId, repository, plan.parent.number, issue.id));
        switch (attached._tag) {
          case "Done":
            return { _tag: "Applied", text: issueText(plan, issue, parentText(plan, true)) } satisfies WriteOutcome;
          case "Uncertain":
            return {
              _tag: "Uncertain",
              text: `Opened issue #${issue.number} in ${plan.repository}: ${issue.url}. Attaching it under #${plan.parent.number} may not have taken effect: ${attached.message}`,
            } satisfies WriteOutcome;
          case "SignedOut":
            return {
              _tag: "Applied",
              text: issueText(plan, issue, parentText(plan, false, "GitHub refused the hub's sign-in.")),
            } satisfies WriteOutcome;
          default:
            return {
              _tag: "Applied",
              text: issueText(plan, issue, parentText(plan, false, attached.message)),
            } satisfies WriteOutcome;
        }
      });

    /** Opens an issue, or a sub-issue under a parent, in the hob's folder's repository. */
    const planIssue = (input: GitHubWriteInput<"github_open_issue">, context: HubPlanContext) =>
      Effect.gen(function* () {
        const { folder, repository } = yield* repositoryFor(context.access, input.folder);
        const { body, note } = yield* markableBody(input.body ?? "", context, "description", "allow");
        const titleNote = redactedNote((context.redacted ?? []).includes("title") ? ["title"] : []);
        const slug = repositorySlug(repository);
        const agentId = context.turn.agentId;
        return yield* pinned(
          agentId,
          repository,
          Effect.gen(function* () {
            const labels = yield* labelsOf(agentId, repository, input.labels ?? []);
            const parent = input.parent === undefined ? null : yield* parentOf(agentId, repository, input.parent);
            const actingAs = yield* github(githubActor(credential, api, agentId));
            const plan: GitHubIssuePlan = {
              repository: slug,
              folder,
              title: input.title,
              body,
              labels,
              parent,
              actingAs,
            };
            // Random per call and never shown to the hob, so no issue it writes can pass for this call's.
            const marker = crypto.randomUUID();
            const request: PolicyRequest = {
              _tag: "Charm",
              charm: GITHUB_CHARM.id,
              operation: "github.open-issue",
              folder,
              site: { repository: slug },
              targets: [parent === null ? `github.com/${slug} issues` : `github.com/${slug} #${parent.number}`],
            };
            return {
              request,
              card: {
                arguments: { ...plan },
                summary: githubIssueSummary(plan),
                label:
                  parent === null
                    ? `Opening an issue ${githubActorText(actingAs)}`
                    : `Opening a sub-issue under #${parent.number} ${githubActorText(actingAs)}`,
              },
              write: {
                site: `github.com/${slug} issues`,
                recorded: { ...plan, marker },
                appliedText: `Opened an issue in ${slug}.`,
                note: `${titleNote}${note}`,
                send: sendPinned(agentId, repository, sendIssue(agentId, repository, plan, marker)),
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
        operation: "github.open-pull-request",
        otherwise: "no pull request can be opened",
        readBack: pullRequestReadBack(api),
        plan: planPullRequest,
      }),
      hubAction({
        tool: writeTool("github_comment"),
        input: GitHubWriteInputs.github_comment,
        effect: "write",
        operation: "github.comment",
        otherwise: "nothing can be commented",
        readBack: commentReadBack(api),
        plan: planComment,
      }),
      hubAction({
        tool: writeTool("github_open_issue"),
        input: GitHubWriteInputs.github_open_issue,
        effect: "write",
        operation: "github.open-issue",
        otherwise: "no issue can be opened",
        readBack: issueReadBack(api),
        plan: planIssue,
      }),
    ];
    return actions;
  });
