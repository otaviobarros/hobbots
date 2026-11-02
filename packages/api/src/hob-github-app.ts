import { AgentId, HobGitHubApp, HobGitHubAppInstallation } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound } from "./errors.ts";
import { GitHubUnreachable } from "./github.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * A hob's own GitHub App (ADR 022), as the hob's Charms tab shows it. Its key and every token stay
 * on the hub; none is ever part of these.
 */
export const HobGitHubAppStatus = Schema.Union([
  Schema.TaggedStruct("None", {
    /** Why this hub cannot make a hob's app: no keychain to keep its key in. Null when it can. */
    cannotCreate: Schema.NullOr(Schema.Literal("no-keychain")),
  }),
  Schema.TaggedStruct("Connected", {
    app: HobGitHubApp,
    /** The bot the hob acts as, such as `frodo-hobbots[bot]`. */
    bot: Schema.String,
    /** Where the user installs the app on more repositories. */
    installUrl: Schema.String,
    /** Where the user deletes the app on GitHub. */
    deleteUrl: Schema.String,
  }),
]);
export type HobGitHubAppStatus = typeof HobGitHubAppStatus.Type;

/** The hub page to open in the default browser on the hub, which takes the user to GitHub. */
export const HobGitHubAppStarted = Schema.Struct({
  url: Schema.String,
  /** When the page stops working, as GitHub's code would. */
  expiresAt: Schema.String,
});
export type HobGitHubAppStarted = typeof HobGitHubAppStarted.Type;

export const HobGitHubAppDisconnected = Schema.Struct({
  /** Where to delete the app on GitHub, the only place an app is deleted; null when there was none. */
  deleteUrl: Schema.NullOr(Schema.String),
  /** What the hub could not undo, such as installations it could not remove, or null. */
  problem: Schema.NullOr(Schema.String),
});
export type HobGitHubAppDisconnected = typeof HobGitHubAppDisconnected.Type;

/**
 * Making the hob's app did not start: the hob is retired, already has one, the hub has no keychain,
 * or the request did not come from the hub's own computer, where GitHub's redirect can reach it.
 */
export class HobGitHubAppRefused extends Schema.TaggedError<HobGitHubAppRefused>()(
  "HobGitHubAppRefused",
  {
    reason: Schema.Literals(["retired", "connected", "no-keychain", "not-local"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class HobGitHubAppGroup extends HttpApiGroup.make("hobGitHubApp")
  .add(
    HttpApiEndpoint.get("status", "/agents/:agentId/github-app", {
      params: { agentId: AgentId },
      success: HobGitHubAppStatus,
      error: AgentNotFound,
    }),
    // Opens a one-hour, one-use state for the hob; only from the hub's own computer.
    HttpApiEndpoint.post("start", "/agents/:agentId/github-app/start", {
      params: { agentId: AgentId },
      success: HobGitHubAppStarted,
      error: [AgentNotFound, HobGitHubAppRefused],
    }),
    HttpApiEndpoint.get("installations", "/agents/:agentId/github-app/installations", {
      params: { agentId: AgentId },
      success: Schema.Struct({ installations: Schema.Array(HobGitHubAppInstallation) }),
      error: [AgentNotFound, GitHubUnreachable],
    }),
    // Removes the app's installations and its key; the hob acts as you again.
    HttpApiEndpoint.post("disconnect", "/agents/:agentId/github-app/disconnect", {
      params: { agentId: AgentId },
      success: HobGitHubAppDisconnected,
      error: AgentNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
