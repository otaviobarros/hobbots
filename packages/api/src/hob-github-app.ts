import { AgentId, HobGitHubApp, HobGitHubAppInstallation, HobGitHubAppMissingPermission } from "@hobbots/domain";
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
    /**
     * Why an app the user already has cannot be linked from here, or null when it can: no keychain, or
     * `not-local`, a browser that is not on the hub's own computer, which must never send the key.
     */
    cannotLink: Schema.NullOr(Schema.Literals(["no-keychain", "not-local"])),
  }),
  Schema.TaggedStruct("Connected", {
    app: HobGitHubApp,
    /** The bot the hob acts as, such as `frodo-hobbots[bot]`. */
    bot: Schema.String,
    /** Where the user installs the app on more repositories. */
    installUrl: Schema.String,
    /** Where the user deletes the app on GitHub. */
    deleteUrl: Schema.String,
    /**
     * Why the app cannot act until the user fixes it, or null. `key`: GitHub refused its key, so the
     * hob needs a new app. `installation`: GitHub refused its tokens, so it needs reinstalling.
     */
    needsReconnect: Schema.NullOr(
      Schema.Struct({ reason: Schema.Literals(["key", "installation"]), message: Schema.String }),
    ),
  }),
  // Disconnected or retired but not fully removed: it no longer acts, and disconnecting again dismisses it.
  Schema.TaggedStruct("LeftOver", {
    app: HobGitHubApp,
    /** What the hub could not remove, such as installations GitHub refused to remove. */
    problem: Schema.String,
    /** Where the user deletes the app on GitHub, which closes what is left. */
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
 * Making or linking the hob's app did not start: the hob is retired, already has one, still shows an
 * old one that was not fully removed, the hub has no keychain, or the request did not come from the
 * hub's own computer. Linking an app the user already has (#1321) can also find: `bad-id`, no app ID or
 * client ID; `not-a-key`, no private key the hub can read; `key-refused`, a key GitHub does not take
 * for that app; `taken`, another hob's app; `unreachable`, GitHub did not answer as expected; and
 * `keychain-failed`, a key the keychain did not keep. The client words each reason itself.
 */
export class HobGitHubAppRefused extends Schema.TaggedError<HobGitHubAppRefused>()(
  "HobGitHubAppRefused",
  {
    reason: Schema.Literals([
      "retired",
      "connected",
      "left-over",
      "no-keychain",
      "not-local",
      "bad-id",
      "not-a-key",
      "key-refused",
      "taken",
      "unreachable",
      "keychain-failed",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** GitHub's private keys are under 4 KB; anything much longer is not one. */
const KEY_LIMIT = 16_384;

/** An app the user already has (#1321): its App ID or client ID, and its private key as GitHub gave it. */
export const HobGitHubAppLink = Schema.Struct({
  appId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  // Redacted as soon as it is decoded, so the hub never logs or shows it.
  privateKey: Schema.RedactedFromValue(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(KEY_LIMIT))),
});
export type HobGitHubAppLink = typeof HobGitHubAppLink.Type;

export const HobGitHubAppLinked = Schema.Struct({
  app: HobGitHubApp,
  /** The bot the hob acts as now. */
  bot: Schema.String,
  missingPermissions: Schema.Array(HobGitHubAppMissingPermission),
});
export type HobGitHubAppLinked = typeof HobGitHubAppLinked.Type;

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
    // Checks an app the user already has with GitHub and keeps its key; only from the hub's own computer.
    HttpApiEndpoint.post("link", "/agents/:agentId/github-app/link", {
      params: { agentId: AgentId },
      payload: HobGitHubAppLink,
      success: HobGitHubAppLinked,
      error: [AgentNotFound, HobGitHubAppRefused],
    }),
    HttpApiEndpoint.get("installations", "/agents/:agentId/github-app/installations", {
      params: { agentId: AgentId },
      success: Schema.Struct({
        installations: Schema.Array(HobGitHubAppInstallation),
        /**
         * While the app is installed nowhere, the permissions the hob's actions use that the app itself
         * lacks, which no installation can say yet. Empty once it is installed: each installation says.
         */
        missingPermissions: Schema.Array(HobGitHubAppMissingPermission),
      }),
      error: [AgentNotFound, GitHubUnreachable],
    }),
    // Removes a made app's installations, and the key of any app; the hob acts as you again. A linked
    // app's installations stay. Dismisses a left-over app.
    HttpApiEndpoint.post("disconnect", "/agents/:agentId/github-app/disconnect", {
      params: { agentId: AgentId },
      success: HobGitHubAppDisconnected,
      error: AgentNotFound,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
