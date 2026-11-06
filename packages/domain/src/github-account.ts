import { Schema } from "effect";

/**
 * The GitHub account the user connects on the hub (#322, ADR 020): the GitHub Charm reaches GitHub
 * as this account. What is stored here is only which sign-in, who and since when, for the UI; the
 * app's tokens live in the OS keychain on the hub, and the other sign-ins stay where the user keeps
 * them.
 */
export const GitHubSource = Schema.Literals(["app", "gh", "git"]);
/**
 * Which sign-in the Charm uses: `app`, the Hobbots GitHub App (recommended: only the repositories
 * you install it on); `gh`, the GitHub CLI's sign-in; `git`, the credential Git keeps for
 * github.com. The last two reach every repository the sign-in can see.
 */
export type GitHubSource = typeof GitHubSource.Type;

export const GitHubAccount = Schema.Struct({
  source: GitHubSource,
  login: Schema.String,
  connectedAt: Schema.String,
});
export type GitHubAccount = typeof GitHubAccount.Type;

/** The repository permissions the Hobbots GitHub App asks for, and nothing else (ADR 020). */
export const GITHUB_APP_PERMISSIONS: ReadonlyArray<{ readonly name: string; readonly access: "read" | "write" }> = [
  { name: "Metadata", access: "read" },
  { name: "Contents", access: "write" },
  { name: "Issues", access: "write" },
  { name: "Pull requests", access: "write" },
  { name: "Checks", access: "read" },
  { name: "Actions", access: "read" },
  { name: "Commit statuses", access: "read" },
  { name: "Workflows", access: "write" },
];

/** A repository the connected account reaches through the app, as GitHub lists it. */
export const GitHubReachableRepository = Schema.Struct({
  fullName: Schema.String,
  private: Schema.Boolean,
});
export type GitHubReachableRepository = typeof GitHubReachableRepository.Type;

/**
 * A hob's own GitHub App (ADR 022): made for one hob from a manifest, owned by the user's personal
 * account, so the hob acts on GitHub as its bot, `<slug>[bot]`. Only its identity is kept here; its
 * private key lives in the OS keychain on the hub, and GitHub's other secrets are never kept.
 */
export const HobGitHubApp = Schema.Struct({
  /** GitHub's app ID. */
  appId: Schema.Number,
  /** The app's client ID, which signs the hub's JSON Web Tokens for it. */
  clientId: Schema.String,
  /** The app's name in its `github.com/apps/<slug>` address. */
  slug: Schema.String,
  /** The personal account that owns the app, and the only one it can be installed on. */
  owner: Schema.String,
  /** The bot's user ID, for its commit email; null when GitHub did not give it when the app was made. */
  botUserId: Schema.NullOr(Schema.Number),
  /** The app's page on GitHub. */
  htmlUrl: Schema.String,
  connectedAt: Schema.String,
});
export type HobGitHubApp = typeof HobGitHubApp.Type;

/** The bot account GitHub gives an app, such as `frodo-hobbots[bot]`. */
export const hobAppBot = (app: Pick<HobGitHubApp, "slug">) => `${app.slug}[bot]`;

/** Who a hob with its own app commits as locally: its bot, at the bot's noreply address (ADR 022). */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * The bot's commit identity. GitHub's noreply address carries the bot's user ID when the hub has it,
 * `<id>+<slug>[bot]@users.noreply.github.com`, and is the older `<slug>[bot]@…` form otherwise.
 */
export const hobAppCommitIdentity = (app: Pick<HobGitHubApp, "slug" | "botUserId">): CommitIdentity => {
  const bot = hobAppBot(app);
  return {
    name: bot,
    email: `${app.botUserId === null ? "" : `${app.botUserId}+`}${bot}@users.noreply.github.com`,
  };
};

/** A GitHub account as GitHub's `/user` gives it: its login, numeric ID and profile name, if set. */
export interface GitHubUser {
  readonly login: string;
  readonly id: number;
  readonly name: string | null;
}

/**
 * The name and email in an answer written as Git writes them, `Ada Lovelace <ada@example.com>`, or
 * null when it holds none (#741). The email needs one `@` with text on both sides and no spaces.
 */
export const parseCommitIdentity = (text: string): CommitIdentity | null => {
  const trimmed = text.trim().replace(/\.$/, "");
  const open = trimmed.lastIndexOf("<");
  if (open === -1 || !trimmed.endsWith(">")) return null;
  const name = trimmed.slice(0, open).trim();
  const email = trimmed.slice(open + 1, -1).trim();
  const at = email.indexOf("@");
  const valid = at > 0 && at === email.lastIndexOf("@") && at < email.length - 1 && !/[\s<>]/.test(email);
  return name === "" || /[<>\n]/.test(name) || !valid ? null : { name, email };
};

/**
 * Who the user commits as with their GitHub account (#741): their profile name, or their login when
 * they set none, at their noreply address `<id>+<login>@users.noreply.github.com`, which GitHub
 * links to the account without showing their own email.
 */
export const githubUserCommitIdentity = (user: GitHubUser): CommitIdentity => ({
  name: user.name?.trim() || user.login,
  email: `${user.id}+${user.login}@users.noreply.github.com`,
});

/** Where a hob's app is installed: the account, whether it reaches all of its repositories or some, and which. */
export const HobGitHubAppInstallation = Schema.Struct({
  id: Schema.Number,
  account: Schema.String,
  repositorySelection: Schema.Literals(["all", "selected"]),
  /** Where the user changes which repositories it reaches. */
  htmlUrl: Schema.String,
  suspended: Schema.Boolean,
  /** The repositories it reaches, as `owner/name`; null while it is suspended, as GitHub then says none. */
  repositories: Schema.NullOr(Schema.Array(Schema.String)),
});
export type HobGitHubAppInstallation = typeof HobGitHubAppInstallation.Type;
