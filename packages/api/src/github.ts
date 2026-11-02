import { GitHubAccount, GitHubReachableRepository } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { UserSessionOnly } from "./user-session.ts";

/**
 * The GitHub account the hub connects for the GitHub Charm (ADR 020), as Settings shows it. No
 * token is ever part of it.
 */
export const GitHubStatus = Schema.Union([
  /** The hub reaches GitHub with the `HOBBOTS_GITHUB_TOKEN` it was started with. */
  Schema.TaggedStruct("Environment", {}),
  /** The account and which sign-in reaches it: the app's, or one the user keeps on the hub. */
  Schema.TaggedStruct("Connected", { account: GitHubAccount }),
  /** The device flow is waiting for the person to enter the code on GitHub. */
  Schema.TaggedStruct("Connecting", {
    userCode: Schema.String,
    verificationUri: Schema.String,
    expiresAt: Schema.String,
  }),
  Schema.TaggedStruct("Disconnected", {
    /** Why the last attempt or sign-in ended, or null. */
    problem: Schema.NullOr(
      Schema.Struct({
        reason: Schema.Literals(["expired", "denied", "refused", "failed"]),
        message: Schema.String,
      }),
    ),
    /** Why this hub cannot connect: no GitHub App named, or no keychain to keep the sign-in in. */
    cannotConnect: Schema.NullOr(Schema.Literals(["no-app", "no-keychain"])),
  }),
]);
export type GitHubStatus = typeof GitHubStatus.Type;

/** The repositories the connected account reaches through the app, and where to add more. */
export const GitHubRepositories = Schema.Struct({
  /** Null when the sign-in is not the app's, and reaches every repository it can see. */
  repositories: Schema.NullOr(Schema.Array(GitHubReachableRepository)),
  installUrl: Schema.String,
});
export type GitHubRepositories = typeof GitHubRepositories.Type;

/**
 * Connecting could not start: the hub uses `HOBBOTS_GITHUB_TOKEN`, names no app, has no keychain,
 * cannot read the chosen sign-in, or GitHub refused. `message` is for logs; clients word the reason.
 */
export class GitHubConnectFailed extends Schema.TaggedError<GitHubConnectFailed>()(
  "GitHubConnectFailed",
  {
    reason: Schema.Literals(["environment", "no-app", "no-keychain", "not-found", "failed"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** GitHub could not list what the account reaches, in words for the person. */
export class GitHubUnreachable extends Schema.TaggedError<GitHubUnreachable>()(
  "GitHubUnreachable",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

/** A sign-in already on the hub that the user can choose instead of the app, with its account. */
export const GitHubFoundSignIn = Schema.Struct({
  source: Schema.Literals(["gh", "git"]),
  login: Schema.String,
});
export type GitHubFoundSignIn = typeof GitHubFoundSignIn.Type;

export class GitHubGroup extends HttpApiGroup.make("github")
  .add(
    HttpApiEndpoint.get("status", "/charms/github", { success: GitHubStatus }),
    // Starts the device flow; pressed again while a code shows, returns that code.
    HttpApiEndpoint.post("connect", "/charms/github/connect", { success: GitHubStatus, error: GitHubConnectFailed }),
    // Reads the sign-ins on the hub, running `gh` and `git` there; Settings asks when it opens.
    HttpApiEndpoint.get("found", "/charms/github/found", { success: Schema.Array(GitHubFoundSignIn) }),
    HttpApiEndpoint.post("use", "/charms/github/use", {
      payload: Schema.Struct({ source: Schema.Literals(["gh", "git"]) }),
      success: GitHubStatus,
      error: GitHubConnectFailed,
    }),
    HttpApiEndpoint.post("cancel", "/charms/github/cancel", { success: GitHubStatus }),
    HttpApiEndpoint.post("disconnect", "/charms/github/disconnect", { success: GitHubStatus }),
    HttpApiEndpoint.get("repositories", "/charms/github/repositories", {
      success: GitHubRepositories,
      error: GitHubUnreachable,
    }),
  )
  .middleware(UserSessionOnly)
  .prefix("/api") {}
