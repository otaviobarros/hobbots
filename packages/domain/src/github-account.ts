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
];

/** A repository the connected account reaches through the app, as GitHub lists it. */
export const GitHubReachableRepository = Schema.Struct({
  fullName: Schema.String,
  private: Schema.Boolean,
});
export type GitHubReachableRepository = typeof GitHubReachableRepository.Type;
