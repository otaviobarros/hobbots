import { Schema } from "effect";
import { toolInputJsonSchema } from "./task-tools.ts";

/**
 * The GitHub Charm's read actions (#317): a hob reads its own repository's details, issues and pull
 * requests through the hub, which holds the GitHub sign-in outside the sandbox (ADR 014). The hub
 * works out the repository from the hob's folder, so what a hob writes never names another one.
 */

/** A repository on github.com, as `owner/name`. */
export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
}

export const repositorySlug = (repository: GitHubRepository): string => `${repository.owner}/${repository.name}`;

// GitHub's own limits: owners are letters, digits and single hyphens; names add `.` and `_`.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The text without its trailing slashes, cut by hand: a `/\/+$/` pattern backtracks on long input. */
export const trimTrailingSlashes = (text: string): string => {
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end);
};

const fromPath = (path: string): GitHubRepository | null => {
  const trimmed = trimTrailingSlashes(path);
  const parts = (trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed).split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  return OWNER.test(owner) && NAME.test(name) && name !== "." && name !== ".." ? { owner, name } : null;
};

/**
 * The github.com repository a Git remote URL names, or null for any other host or shape. Accepts
 * `https://github.com/owner/name(.git)`, `ssh://git@github.com/owner/name(.git)` and
 * `git@github.com:owner/name(.git)`. A URL with other user info, a port or a query names no repository.
 */
export const githubRepositoryOf = (remote: string): GitHubRepository | null => {
  const trimmed = remote.trim();
  const scp = /^git@github\.com:([^/:][^:]*)$/i.exec(trimmed);
  if (scp) return fromPath(scp[1] as string);
  // No user info other than ssh's `git@`, no port, no query or fragment: the host is github.com alone.
  const url = /^(?:https:\/\/|ssh:\/\/git@)github\.com\/([^?#@:]+)$/i.exec(trimmed);
  return url ? fromPath(url[1] as string) : null;
};

/** A pull request on github.com: its repository and number. */
export interface GitHubPullRequestRef {
  readonly repository: GitHubRepository;
  readonly number: number;
}

/** A pull request's URL on GitHub, whatever follows its number. */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/;

/** The pull request a URL names, such as `https://github.com/owner/name/pull/12/files`, or null. */
export const pullRequestOf = (url: string): GitHubPullRequestRef | null => {
  const found = PULL_REQUEST_URL.exec(url);
  if (found === null) return null;
  const repository = fromPath(`${found[1]}/${found[2]}`);
  const number = Number(found[3]);
  return repository === null || !Number.isSafeInteger(number) || number < 1 ? null : { repository, number };
};

const folder = Schema.optionalKey(
  Schema.String.check(Schema.isNonEmpty()).annotate({
    description:
      "An absolute folder of yours whose repository to read. Leave it out to read the repository of your first folder that has one on GitHub.",
  }),
);

// Words that reach GitHub's search query: a label is quoted and holds no quote, so neither can add
// another qualifier, such as `repo:`.
const label = Schema.String.check(
  Schema.isPattern(/^[^"\\\r\n\t]{1,50}$/, { message: "A label is at most 50 characters, without quotes." }),
).annotate({ description: "Only items with this label." });
const assignee = Schema.String.check(Schema.isPattern(OWNER, { message: "An assignee is a GitHub login." })).annotate({
  description: "Only items assigned to this GitHub login.",
});

export const GitHubSearchKind = Schema.Literals(["issue", "pull_request"]);
export type GitHubSearchKind = typeof GitHubSearchKind.Type;

export const GitHubSearchState = Schema.Literals(["open", "closed", "merged", "all"]);
export type GitHubSearchState = typeof GitHubSearchState.Type;

export const GitHubToolInputs = {
  github_repository: Schema.Struct({ folder }),
  github_search: Schema.Struct({
    folder,
    kind: GitHubSearchKind.annotate({ description: "Issues or pull requests." }),
    state: Schema.optionalKey(
      GitHubSearchState.annotate({
        description: "open (the default), closed, merged (pull requests only) or all.",
      }),
    ),
    label: Schema.optionalKey(label),
    assignee: Schema.optionalKey(assignee),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })).annotate({
        description: "How many of the newest matches to list, 0 to 30 (default 10). The total is always given.",
      }),
    ),
  }),
  github_item: Schema.Struct({
    folder,
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "The issue or pull request number.",
    }),
    comments: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })).annotate({
        description: "How many of its first comments to include, 0 to 20 (default 10).",
      }),
    ),
  }),
} as const;

/** Why a branch name is refused: the hub passes names to Git, so none may read as an option or another ref. */
export const branchNameProblem = (name: string): string | null => {
  if (name.startsWith("-")) return `${name} starts with "-", so it could read as an option.`;
  if (name === "HEAD" || name.startsWith("refs/")) return `${name} names a ref, not a branch.`;
  return null;
};

const branchName = (description: string) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(255),
    Schema.makeFilter((name: string) => branchNameProblem(name) ?? undefined),
  ).annotate({ description });

/** The folder a write acts from, whose repository the hub resolves. */
const writeFolder = (what: string) =>
  Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty()).annotate({
      description: `An absolute folder of yours whose repository to ${what}. Leave it out to use your first folder that has one on GitHub.`,
    }),
  );

/** GitHub keeps at most 65,536 characters in a body or comment; the hub's marker and notes take a little. */
export const MAX_GITHUB_BODY = 60_000;

const githubBody = (description: string) =>
  Schema.String.check(Schema.isMaxLength(MAX_GITHUB_BODY)).annotate({ description });

/** The most labels an issue a hob opens may carry. */
export const MAX_ISSUE_LABELS = 10;

// A label GitHub has: at most 50 characters, as GitHub allows, and on one line.
const issueLabel = Schema.String.check(
  Schema.isPattern(/^[^\r\n\t]{1,50}$/, { message: "A label is 1 to 50 characters, on one line." }),
);

/**
 * The GitHub writes' inputs, as each action declares them. The hub action pipeline adds the `key`
 * every Charm write carries (ADR 031).
 */
export const GitHubWriteInputs = {
  github_push: Schema.Struct({
    folder: writeFolder("push"),
    branch: branchName("Your local branch to push. The hub pushes the commit it points to when the call is decided."),
    remote_branch: Schema.optionalKey(branchName("The branch on GitHub to update. Defaults to the same name.")),
    force: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Replace the branch on GitHub even when your branch does not build on it. Always asks the user, once only.",
      }),
    ),
  }),
  github_open_pull_request: Schema.Struct({
    folder: writeFolder("open the pull request in"),
    head: branchName("The branch on GitHub with your changes, already pushed with github_push."),
    base: Schema.optionalKey(branchName("The branch to merge into. Defaults to the repository's default branch.")),
    title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
      description: "The pull request's title.",
    }),
    body: Schema.optionalKey(githubBody("The pull request's description, in GitHub Markdown.")),
    draft: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Open it as a draft (the default), or ready for review." }),
    ),
  }),
  github_comment: Schema.Struct({
    folder: writeFolder("comment in"),
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "The issue or pull request number to comment on.",
    }),
    body: githubBody("The comment, in GitHub Markdown.").check(Schema.isNonEmpty()),
  }),
  github_open_issue: Schema.Struct({
    folder: writeFolder("open the issue in"),
    title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
      description: "The issue's title.",
    }),
    body: Schema.optionalKey(githubBody("The issue's description, in GitHub Markdown.")),
    labels: Schema.optionalKey(
      Schema.Array(issueLabel)
        .check(Schema.isMaxLength(MAX_ISSUE_LABELS))
        .annotate({
          description: `Labels the repository already has, at most ${MAX_ISSUE_LABELS}. A label it does not have is refused.`,
        }),
    ),
    parent: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "An issue number in the same repository to open this one under, as its sub-issue.",
      }),
    ),
  }),
} as const;

export type GitHubWriteToolName = keyof typeof GitHubWriteInputs;
export type GitHubWriteInput<N extends GitHubWriteToolName> = (typeof GitHubWriteInputs)[N]["Type"];

export const isGitHubWriteToolName = (name: string): name is GitHubWriteToolName =>
  Object.hasOwn(GitHubWriteInputs, name);

/** The JSON Schema a runtime advertises for a GitHub write tool's input. */
export const githubWriteToolJsonSchema = (name: GitHubWriteToolName): Record<string, unknown> =>
  toolInputJsonSchema(GitHubWriteInputs[name]);

/** The tool a hob pushes with, which the policy hook points a `git push` command to. */
export const GITHUB_PUSH_TOOL = "github_push";

export const GITHUB_WRITE_TOOLS: ReadonlyArray<{
  readonly name: GitHubWriteToolName;
  readonly description: string;
  readonly label: string;
}> = [
  {
    name: "github_push",
    description:
      "Push a branch of your folder's repository to GitHub, as the user. Use this instead of `git push`, which cannot sign in from your sandbox. The hub pushes the commit your branch points to when the call is decided; under most policies the user approves it first. Without force, GitHub refuses a push when its branch moved.",
    label: "Pushing to GitHub",
  },
  {
    name: "github_open_pull_request",
    description:
      "Open a pull request in your folder's GitHub repository, from a branch you already pushed with github_push. It opens as your own GitHub app's bot when you have one, and as the user otherwise. Use this instead of `gh pr create`. It opens as a draft unless you say otherwise; under most policies the user approves it first.",
    label: "Opening a pull request",
  },
  {
    name: "github_comment",
    description:
      "Comment on an issue or pull request in your folder's GitHub repository, as your own GitHub app's bot when you have one, and as the user otherwise. Use this instead of `gh issue comment` or `gh pr comment`. Under most policies the user approves it first.",
    label: "Commenting on GitHub",
  },
  {
    name: "github_open_issue",
    description:
      "Open an issue in your folder's GitHub repository, as your own GitHub app's bot when you have one, and as the user otherwise. Give a parent issue number to open it as that issue's sub-issue. Labels must already exist in the repository. Use this instead of `gh issue create`. Under most policies the user approves it first.",
    label: "Opening an issue",
  },
];

/**
 * Who acts on GitHub for a hob's call (ADR 022): the hob's own app, as its bot, or the user's
 * account, with its login when the hub knows it. The step and the approval card name it.
 */
export type GitHubActor =
  | { readonly _tag: "HobApp"; readonly hob: string; readonly bot: string }
  | { readonly _tag: "You"; readonly login: string | null };

/** The hob's own app as who acts. */
export type GitHubHobAppActor = Extract<GitHubActor, { readonly _tag: "HobApp" }>;

/** Who acts in words, as a card's last line ends: "as Frodo's app, frodo-hobbots[bot]" or "as you (@login)". */
export const githubActorText = (actor: GitHubActor): string =>
  actor._tag === "HobApp"
    ? `as ${actor.hob}'s app, ${actor.bot}`
    : `as you${actor.login === null ? "" : ` (@${actor.login})`}`;

/** The account GitHub shows as the author of what the actor writes, when the hub knows it. */
export const githubActorLogin = (actor: GitHubActor): string | null =>
  actor._tag === "HobApp" ? actor.bot : actor.login;

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** What a push sends and where, as the hub fixed it when deciding, and what the approval card shows. */
export interface GitHubPushPlan {
  readonly repository: string;
  readonly folder: string;
  readonly branch: string;
  readonly remoteBranch: string;
  readonly commit: string;
  readonly force: boolean;
  /** The commit the branch on GitHub was at when deciding, or null when it did not exist. */
  readonly replaces: string | null;
  readonly defaultBranch: string;
  readonly toDefaultBranch: boolean;
  /** The commits the push adds beyond what GitHub's branches have, and the first of their subjects. */
  readonly commits: number;
  readonly subjects: ReadonlyArray<string>;
  /** Who acts on GitHub. */
  readonly actingAs: GitHubActor;
  /** Over SSH with the user's agent, which only the user's account uses. */
  readonly over: "https" | "ssh";
}

const short = (commit: string) => commit.slice(0, 12);

/** The push in words, as the approval card shows it and its digest covers it. */
export const githubPushSummary = (plan: GitHubPushPlan): string =>
  [
    `Push ${short(plan.commit)} from ${plan.branch} to ${plan.repository} branch ${plan.remoteBranch}${plan.toDefaultBranch ? " (the default branch)" : ""}`,
    plan.replaces === null
      ? "Creates the branch on GitHub."
      : plan.force
        ? `Force: replaces ${short(plan.replaces)}, even where the branch does not build on it.`
        : `Updates the branch from ${short(plan.replaces)}.`,
    `${plan.commits} commit${plan.commits === 1 ? "" : "s"} GitHub's branches do not have${plan.subjects.length > 0 ? ":" : "."}`,
    ...plan.subjects.map((subject) => `  ${subject}`),
    // A hob's app pushes through GitHub's API, which makes the commits anew (ADR 022).
    ...(plan.actingAs._tag === "HobApp"
      ? ["GitHub creates these commits again, signed as the bot, with new IDs and dates."]
      : []),
    plan.over === "ssh"
      ? `Over SSH with your agent, ${githubActorText(plan.actingAs)}.`
      : sentence(githubActorText(plan.actingAs)),
  ].join("\n");

/** What opening a pull request sends and where, as the hub fixed it when deciding. */
export interface GitHubPullRequestPlan {
  readonly repository: string;
  readonly folder: string;
  readonly head: string;
  readonly base: string;
  /** The title and body after redaction: exactly what is sent. */
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly actingAs: GitHubActor;
}

/** What a comment sends and where, as the hub fixed it when deciding. */
export interface GitHubCommentPlan {
  readonly repository: string;
  readonly folder: string;
  readonly number: number;
  readonly pullRequest: boolean;
  /** The issue or pull request's title, as GitHub had it when deciding. */
  readonly itemTitle: string;
  /** The comment after redaction, without the hub's marker: exactly what the hob wrote that is sent. */
  readonly body: string;
  readonly actingAs: GitHubActor;
}

/** What opening an issue sends and where, as the hub fixed it when deciding. */
export interface GitHubIssuePlan {
  readonly repository: string;
  readonly folder: string;
  /** The title and body after redaction, the body without the hub's marker: exactly what the hob wrote that is sent. */
  readonly title: string;
  readonly body: string;
  /** The labels as GitHub names them. */
  readonly labels: ReadonlyArray<string>;
  /** The issue it opens under, as GitHub had it when deciding, or null for an issue of its own. */
  readonly parent: { readonly number: number; readonly title: string } | null;
  readonly actingAs: GitHubActor;
}

/** How much of a pull request's body its approval card shows, which ADR 020 calls the start of the body. */
export const PULL_REQUEST_BODY_SHOWN = 1200;

/** Opening a pull request in words, as the approval card shows it and its digest covers it. */
export const githubPullRequestSummary = (plan: GitHubPullRequestPlan): string => {
  const body =
    plan.body.length <= PULL_REQUEST_BODY_SHOWN
      ? plan.body
      : `${plan.body.slice(0, PULL_REQUEST_BODY_SHOWN)}\n[${plan.body.length - PULL_REQUEST_BODY_SHOWN} more characters]`;
  return [
    `Open a ${plan.draft ? "draft " : ""}pull request in ${plan.repository} from ${plan.head} into ${plan.base}`,
    `Title: ${plan.title}`,
    ...(body === "" ? ["No description."] : ["", body, ""]),
    sentence(githubActorText(plan.actingAs)),
  ].join("\n");
};

/** The start of a body, as an approval card shows it: up to `PULL_REQUEST_BODY_SHOWN` characters. */
const bodyShown = (body: string) =>
  body.length <= PULL_REQUEST_BODY_SHOWN
    ? body
    : `${body.slice(0, PULL_REQUEST_BODY_SHOWN)}\n[${body.length - PULL_REQUEST_BODY_SHOWN} more characters]`;

/** Opening an issue in words, as the approval card shows it and its digest covers it. */
export const githubIssueSummary = (plan: GitHubIssuePlan): string => {
  const body = bodyShown(plan.body);
  return [
    plan.parent === null
      ? `Open an issue in ${plan.repository}`
      : `Open a sub-issue in ${plan.repository} under #${plan.parent.number}: ${plan.parent.title}`,
    `Title: ${plan.title}`,
    ...(plan.labels.length === 0 ? [] : [`Labels: ${plan.labels.join(", ")}`]),
    ...(body === "" ? ["No description."] : ["", body, ""]),
    sentence(githubActorText(plan.actingAs)),
  ].join("\n");
};

/** A comment in words, as the approval card shows it and its digest covers it. */
export const githubCommentSummary = (plan: GitHubCommentPlan): string =>
  [
    `Comment on ${plan.pullRequest ? "pull request" : "issue"} #${plan.number} in ${plan.repository}: ${plan.itemTitle}`,
    "",
    plan.body,
    "",
    sentence(githubActorText(plan.actingAs)),
  ].join("\n");

/**
 * The hidden marker the hub ends each comment with (ADR 020), so reading GitHub back after an unclear
 * end finds this call's comment. The nonce is the hub's, random per call, and never shown to the hob.
 */
export const commentMarker = (nonce: string): string => `<!-- hobbots-call: ${nonce} -->`;

const MARKER_WORD = "hobbots-call";

/**
 * The body without anything shaped like the hub's marker: every HTML comment that starts with
 * `hobbots-call`, in any case, closed or running to the end. One plain scan, so it runs in linear time
 * on any input (STD-SEC-005). Removing one can join the text around it into another, which
 * `hasCommentMarker` finds on the result.
 */
export const stripCommentMarkers = (body: string): string => {
  let out = "";
  let at = 0;
  for (;;) {
    const open = body.indexOf("<!--", at);
    if (open === -1) return out + body.slice(at);
    const word = markerWordAt(body, open);
    if (word === -1) {
      out += body.slice(at, open + 4);
      at = open + 4;
      continue;
    }
    const close = body.indexOf("-->", word);
    out += body.slice(at, open);
    at = close === -1 ? body.length : close + 3;
  }
};

/** Where the marker's word ends when an HTML comment opened at `open` starts with it, else -1. */
const markerWordAt = (text: string, open: number): number => {
  let start = open + 4;
  while (start < text.length && /\s/.test(text[start] as string)) start++;
  const end = start + MARKER_WORD.length;
  return text.slice(start, end).toLowerCase() === MARKER_WORD ? end : -1;
};

/** Whether the text holds anything shaped like the hub's marker, in linear time. */
export const hasCommentMarker = (text: string): boolean => {
  for (let open = text.indexOf("<!--"); open !== -1; open = text.indexOf("<!--", open + 4)) {
    if (markerWordAt(text, open) !== -1) return true;
  }
  return false;
};

export type GitHubToolName = keyof typeof GitHubToolInputs;
export type GitHubToolInput<N extends GitHubToolName> = (typeof GitHubToolInputs)[N]["Type"];

export const isGitHubToolName = (name: string): name is GitHubToolName => Object.hasOwn(GitHubToolInputs, name);

/** The JSON Schema a runtime advertises for a GitHub tool's input. */
export const githubToolJsonSchema = (name: GitHubToolName): Record<string, unknown> =>
  toolInputJsonSchema(GitHubToolInputs[name]);

export const GITHUB_TOOLS: ReadonlyArray<{
  readonly name: GitHubToolName;
  readonly description: string;
  readonly label: string;
}> = [
  {
    name: "github_repository",
    description:
      "Read your folder's GitHub repository: its name, description, default branch, visibility and link. Use this instead of `gh repo view`, which cannot sign in from your sandbox.",
    label: "Reading the GitHub repository",
  },
  {
    name: "github_search",
    description:
      "Count and list your folder's GitHub issues or pull requests by state, label or assignee. Use this instead of `gh issue list` or `gh pr list`, which cannot sign in from your sandbox.",
    label: "Searching GitHub",
  },
  {
    name: "github_item",
    description:
      "Read one issue or pull request of your folder's GitHub repository, with its first comments. Use this instead of `gh issue view` or `gh pr view`.",
    label: "Reading a GitHub item",
  },
];

/** The search query for a `github_search` call, scoped to the repository by the hub alone. */
export const githubSearchQuery = (repository: GitHubRepository, input: GitHubToolInput<"github_search">): string => {
  const state = input.state ?? "open";
  const parts = [`repo:${repositorySlug(repository)}`, input.kind === "issue" ? "is:issue" : "is:pr"];
  if (state === "merged") parts.push("is:merged");
  else if (state !== "all") parts.push(`is:${state}`);
  if (input.label !== undefined) parts.push(`label:"${input.label}"`);
  if (input.assignee !== undefined) parts.push(`assignee:${input.assignee}`);
  return parts.join(" ");
};

/** What GitHub answered, in the few fields a hob reads. */
export interface GitHubRepositoryInfo {
  readonly fullName: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly visibility: string;
  readonly url: string;
  readonly openIssuesAndPullRequests: number;
}

export interface GitHubItemSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string | null;
  readonly updatedAt: string;
}

export interface GitHubSearchResult {
  readonly query: string;
  readonly total: number;
  readonly items: ReadonlyArray<GitHubItemSummary>;
}

export interface GitHubComment {
  readonly author: string | null;
  readonly createdAt: string;
  readonly body: string;
}

export interface GitHubItem extends GitHubItemSummary {
  readonly pullRequest: boolean;
  readonly url: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly commentCount: number;
  readonly comments: ReadonlyArray<GitHubComment>;
}

const by = (author: string | null) => (author === null ? "" : ` by @${author}`);

const line = (item: GitHubItemSummary) =>
  `#${item.number} [${item.state}] ${item.title}${by(item.author)}, updated ${item.updatedAt}`;

export const githubRepositoryText = (info: GitHubRepositoryInfo): string =>
  [
    `${info.fullName} (${info.visibility}), default branch ${info.defaultBranch}`,
    info.url,
    info.description ?? "No description.",
    `Open issues and pull requests together: ${info.openIssuesAndPullRequests}. Use github_search to count each.`,
  ].join("\n");

export const githubSearchText = (result: GitHubSearchResult): string =>
  [
    `${result.total} match${result.total === 1 ? "" : "es"} for \`${result.query}\`.`,
    ...result.items.map(line),
    ...(result.items.length < result.total && result.items.length > 0
      ? [`Showing the ${result.items.length} most recently updated.`]
      : []),
  ].join("\n");

export const githubItemText = (item: GitHubItem): string =>
  [
    `${item.pullRequest ? "Pull request" : "Issue"} ${line(item)}`,
    item.url,
    ...(item.labels.length > 0 ? [`Labels: ${item.labels.join(", ")}`] : []),
    "",
    item.body === "" ? "No description." : item.body,
    "",
    `${item.commentCount} comment${item.commentCount === 1 ? "" : "s"}${item.comments.length < item.commentCount ? `, the first ${item.comments.length} below` : ""}.`,
    ...item.comments.flatMap((comment) => ["", `Comment${by(comment.author)} on ${comment.createdAt}:`, comment.body]),
  ].join("\n");
