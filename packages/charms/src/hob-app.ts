import {
  DeviceRepository,
  GrantService,
  HobbotsRepository,
  HobGitHubApps,
  RetiredHobGitHubApp,
  SecretRedaction,
} from "@hobbots/agents";
import {
  type AgentId,
  type DeviceId,
  type HobGitHubApp,
  type HobGitHubAppInstallation,
  type HobGitHubAppMissingPermission,
  hobAppBot,
} from "@hobbots/domain";
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { sendToGitHub } from "./github-api.ts";
import { appJwt } from "./github-app-jwt.ts";
import { GitHubError } from "./github-error.ts";
import { GITHUB_CHARM } from "./github-operations.ts";
import { allPages, GITHUB_HOSTS, GITHUB_PAGE_SIZE, type GitHubHosts } from "./github-sign-in.ts";
import { type HobAppReconnect, HobAppTokens, makeHobAppTokens } from "./hob-app-tokens.ts";
import { deleteOutcome, HobAppKeys, type KeychainError } from "./keychain.ts";

/**
 * A hob's own GitHub App (#223, ADR 022), made from a manifest so the user never fills in an app's
 * settings or handles a key file. The hub page posts the manifest to GitHub, GitHub redirects back
 * to the hub with a code, and the hub exchanges it for the app's identity and private key. The key
 * goes to the OS keychain; GitHub's client and webhook secrets are dropped at once. The hub signs in
 * as the app with a JWT to list and remove its installations, and to mint its tokens (#224).
 *
 * An app the user already has can be linked instead (#1321): they give its ID and private key, and
 * the hub reads the app with a JWT signed with that key before it keeps the key in the keychain. The
 * hub did not make a linked app, so disconnecting it only forgets its key.
 */

/** The repository permissions of the Hobbots GitHub App (ADR 020), and nothing else, by GitHub's names. */
export const HOB_APP_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "read",
  actions: "read",
  statuses: "read",
  workflows: "write",
} as const;

/** GitHub's longest app name. */
const NAME_LIMIT = 34;
const NAME_SUFFIX = "-hobbots";
/** A state lasts as long as GitHub lets the hub exchange the code. */
const STATE_TTL_MS = 60 * 60_000;
const STATE_BYTES = 32;

/** The callback on the hub that GitHub redirects to, at the hub's loopback address. */
export const HOB_APP_CALLBACK_PATH = "/github/hob-app/callback";
/** The hub page that posts the manifest to GitHub. */
export const HOB_APP_NEW_PATH = "/github/hob-app/new";

/** The hob's app as Settings and the Charms tab show it. */
export type HobAppStatus =
  | {
      readonly _tag: "None";
      /** Why a hob's app cannot be made on this hub, or null when it can. */
      readonly cannotCreate: "no-keychain" | null;
    }
  | {
      readonly _tag: "Connected";
      readonly app: HobGitHubApp;
      /** The bot the hob acts as, such as `frodo-hobbots[bot]`. */
      readonly bot: string;
      /** Where the user installs the app on more repositories. */
      readonly installUrl: string;
      /** Where the user deletes the app on GitHub, the only place it can be deleted. */
      readonly deleteUrl: string;
      /** Why the app cannot act until the user fixes it, or null. */
      readonly needsReconnect: HobAppReconnect | null;
    }
  | {
      /**
       * Disconnected or retired, but not fully removed: the app no longer acts and its key is gone,
       * yet installations may remain. Shown until the user dismisses it by disconnecting again.
       */
      readonly _tag: "LeftOver";
      readonly app: HobGitHubApp;
      /** What the hub could not remove. */
      readonly problem: string;
      /** Where the user deletes the app on GitHub, which closes what is left. */
      readonly deleteUrl: string;
    };

/**
 * Why making or linking a hob's app did not start. Linking can also find: `bad-id`, an ID that is no
 * app ID or client ID; `not-a-key`, a key the hub cannot read; `key-refused`, a key GitHub does not take
 * for that app; `taken`, an app another hob already has; `unreachable`, GitHub did not answer as
 * expected; and `keychain-failed`, a key the keychain did not keep.
 */
export class HobAppRefused extends Schema.TaggedError<HobAppRefused>()("HobAppRefused", {
  reason: Schema.Literals([
    "not-found",
    "retired",
    "connected",
    "left-over",
    "no-keychain",
    "bad-id",
    "not-a-key",
    "key-refused",
    "taken",
    "unreachable",
    "keychain-failed",
  ]),
  message: Schema.String,
}) {}

/** What the user gives to link an app they already have (#1321): its app ID or client ID, and its key. */
export interface HobAppLinkRequest {
  readonly appId: string;
  readonly privateKey: Redacted.Redacted<string>;
}

export interface HobAppLinked {
  readonly app: HobGitHubApp;
  readonly bot: string;
  /** The permissions of `HOB_APP_PERMISSIONS` the app lacks, so the user can add them on GitHub. */
  readonly missingPermissions: ReadonlyArray<HobGitHubAppMissingPermission>;
}

/** Why the redirect from GitHub did not give the hob its app. */
export class HobAppNotMade extends Schema.TaggedError<HobAppNotMade>()("HobAppNotMade", {
  /** `unknown`: no live, unused state of this hub's, answered `404`. */
  reason: Schema.Literals(["unknown", "failed"]),
  message: Schema.String,
  /** The app's page on GitHub where it can be deleted, when GitHub made one the hob cannot keep. */
  deleteUrl: Schema.NullOr(Schema.String),
}) {}

/** The page that posts the manifest: GitHub's address for a new app, and the manifest as JSON. */
export interface HobAppManifestForm {
  readonly hobName: string;
  readonly action: string;
  readonly manifest: string;
}

export interface HobAppMade {
  readonly agentId: AgentId;
  readonly hobName: string;
  readonly app: HobGitHubApp;
  readonly installUrl: string;
}

/** What disconnecting did: where to delete the app on GitHub, and what could not be done. */
export interface HobAppDisconnected {
  /** Null when the hob had no app. */
  readonly deleteUrl: string | null;
  /** Why its installations may still be in place, or null when every one was removed. */
  readonly problem: string | null;
}

export class HobGitHubAppService extends Context.Service<
  HobGitHubAppService,
  {
    readonly status: (agentId: AgentId) => Effect.Effect<HobAppStatus, HobAppRefused>;
    /**
     * Opens a state for the hob, bound to the device that asked, and returns the hub page that
     * posts the manifest. `hubUrl` is the hub's loopback address, where GitHub redirects.
     */
    readonly start: (
      agentId: AgentId,
      deviceId: DeviceId,
      hubUrl: string,
    ) => Effect.Effect<{ readonly url: string; readonly expiresAt: string }, HobAppRefused>;
    /** The manifest form for a live, unused state, or none. */
    readonly form: (state: string) => Effect.Effect<Option.Option<HobAppManifestForm>>;
    /** Uses the state once and exchanges GitHub's code for the app. */
    readonly complete: (state: string, code: string) => Effect.Effect<HobAppMade, HobAppNotMade>;
    /** Where the hob's app is installed, as GitHub lists it now. */
    readonly installations: (
      agentId: AgentId,
    ) => Effect.Effect<ReadonlyArray<HobGitHubAppInstallation>, GitHubError | HobAppRefused>;
    /** Checks an app the user already has against GitHub, keeps its key and gives it to the hob (#1321). */
    readonly link: (agentId: AgentId, request: HobAppLinkRequest) => Effect.Effect<HobAppLinked, HobAppRefused>;
    /** The permissions the hob's actions use that the app itself lacks, as GitHub lists the app's now. */
    readonly appMissing: (
      agentId: AgentId,
    ) => Effect.Effect<ReadonlyArray<HobGitHubAppMissingPermission>, GitHubError | HobAppRefused>;
    /** Removes a made app's installations, then its key, then forgets it. A linked app keeps its installations. */
    readonly disconnect: (agentId: AgentId) => Effect.Effect<HobAppDisconnected, HobAppRefused>;
  }
>()("@hobbots/charms/HobGitHubAppService") {}

/** The app's name for a hob: its name in GitHub's characters, then `-hobbots`, cut to GitHub's 34. */
export const hobAppName = (hobName: string) => {
  const base = hobName
    .normalize("NFKD")
    // Accents come apart from their letters under NFKD, and are dropped.
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = (base === "" ? "hob" : base).slice(0, NAME_LIMIT - NAME_SUFFIX.length).replace(/-+$/, "");
  return `${cut === "" ? "hob" : cut}${NAME_SUFFIX}`;
};

/** The manifest GitHub makes the hob's app from (ADR 022). */
export const hobAppManifest = (hobName: string, redirectUrl: string) => ({
  name: hobAppName(hobName),
  url: "https://hobbots.app",
  description: `${hobName}'s identity on GitHub, made by Hobbots for this hob alone. It acts only where you install it.`,
  public: false,
  default_permissions: HOB_APP_PERMISSIONS,
  default_events: [],
  // GitHub asks for a webhook URL; the app subscribes to no event and its webhook stays off.
  hook_attributes: { url: "https://hobbots.app", active: false },
  redirect_url: redirectUrl,
});

const ConversionJson = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  client_id: Schema.String,
  html_url: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
  pem: Schema.String,
});
const UserJson = Schema.Struct({ id: Schema.Number });
/** What `GET /app` says of the app a JWT signs in as. */
const AppJson = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  client_id: Schema.String,
  html_url: Schema.String,
  owner: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  permissions: Schema.Record(Schema.String, Schema.String),
});

/** An app ID, or a client ID such as `Iv1.0123abcd` or `Iv23li…`; anything else never signs a JWT. */
const APP_ID = /^(?:[0-9]{1,12}|Iv[0-9A-Za-z.]{1,40})$/;

/** The permissions the hob's actions ask for that `granted`, as GitHub lists an app's, does not give. */
export const missingPermissions = (granted: Readonly<Record<string, string>>): Array<HobGitHubAppMissingPermission> =>
  Object.entries(HOB_APP_PERMISSIONS).flatMap(([name, access]) => {
    const has = granted[name];
    const enough = has === "write" || has === "admin" || (has === "read" && access === "read");
    return enough ? [] : [{ name: name as keyof typeof HOB_APP_PERMISSIONS, access }];
  });
const InstallationJson = Schema.Struct({
  id: Schema.Number,
  account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  repository_selection: Schema.Literals(["all", "selected"]),
  html_url: Schema.String,
  suspended_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const AccessTokenJson = Schema.Struct({ token: Schema.String, expires_at: Schema.String });
const InstallationRepositoriesJson = Schema.Struct({
  repositories: Schema.Array(Schema.Struct({ full_name: Schema.String })),
});

/** A token for the repositories' names this close to expiry is replaced. */
const NAMES_TOKEN_AHEAD_MS = 5 * 60_000;

const answeredError = (status: number, what: string) =>
  new GitHubError({ reason: "failed", message: `GitHub answered ${status} for ${what}.` });
const answered = (status: number, what: string) => Effect.fail(answeredError(status, what));

// A code GitHub hands back is short and URL-safe; anything else never reaches its API.
const CODE = /^[A-Za-z0-9_-]{1,256}$/;

interface OpenState {
  readonly agentId: AgentId;
  readonly deviceId: DeviceId;
  readonly hobName: string;
  readonly redirectUrl: string;
  readonly expiresAt: number;
}

/** A hob's own GitHub App, over `HttpClient`, against GitHub at `hosts`. */
export const HobGitHubAppLive = (hosts: GitHubHosts = GITHUB_HOSTS) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const keys = yield* HobAppKeys;
      const apps = yield* HobGitHubApps;
      const hobs = yield* HobbotsRepository;
      const grants = yield* GrantService;
      const devices = yield* DeviceRepository;
      const random = yield* SecureRandom.SecureRandom;
      const digest = yield* Digest.Digest;
      const redaction = yield* Effect.serviceOption(SecretRedaction);
      // Making, disconnecting and retiring one hob's app never interleave.
      const writing = yield* Semaphore.make(1);
      // Only the hash of each state, as for pairing secrets; one live state per hob.
      const states = new Map<string, OpenState>();

      const hashOf = (state: string) => digest.digestHex(Digest.sha256, new TextEncoder().encode(state));
      const remember = (value: string, kind: string) =>
        Option.isSome(redaction) ? Effect.sync(() => redaction.value.remember({ value, kind })) : Effect.void;

      const installUrl = (app: HobGitHubApp) => `${hosts.web}/apps/${app.slug}/installations/new`;
      const deleteUrl = (slug: string) => `${hosts.web}/settings/apps/${slug}/advanced`;

      const send = (request: HttpClientRequest.HttpClientRequest, what: string) => sendToGitHub(http, request, what);

      const read = <S extends Schema.Constraint>(
        response: HttpClientResponse.HttpClientResponse,
        schema: S,
        what: string,
      ): Effect.Effect<S["Type"], GitHubError, S["DecodingServices"]> =>
        HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(
            () => new GitHubError({ reason: "failed", message: `GitHub's answer for ${what} was not as expected.` }),
          ),
        );

      const agentOf = (agentId: AgentId) =>
        hobs.findAgent(agentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new HobAppRefused({ reason: "not-found", message: "There is no such hob." })),
              onSome: Effect.succeed,
            }),
          ),
        );

      const status = (agentId: AgentId) =>
        Effect.gen(function* (): Effect.fn.Return<HobAppStatus, HobAppRefused> {
          yield* agentOf(agentId);
          const app = yield* apps.get(agentId);
          if (app === null) {
            const left = yield* apps.leftOver(agentId);
            if (left !== null) return { _tag: "LeftOver", ...left, deleteUrl: deleteUrl(left.app.slug) };
            return { _tag: "None", cannotCreate: (yield* keys.usable) ? null : "no-keychain" };
          }
          return {
            _tag: "Connected",
            app,
            bot: hobAppBot(app),
            installUrl: installUrl(app),
            deleteUrl: deleteUrl(app.slug),
            needsReconnect: tokens.reconnect(agentId, app),
          };
        });

      /** Fails when the hob cannot be given an app now, whether made or linked. */
      const canGive = (agentId: AgentId) =>
        Effect.gen(function* () {
          const agent = yield* agentOf(agentId);
          if (agent.status === "retired") {
            return yield* new HobAppRefused({ reason: "retired", message: `${agent.name} is retired.` });
          }
          if ((yield* apps.get(agentId)) !== null) {
            return yield* new HobAppRefused({
              reason: "connected",
              message: `${agent.name} already has its own GitHub app. Disconnect it first.`,
            });
          }
          if ((yield* apps.leftOver(agentId)) !== null) {
            return yield* new HobAppRefused({
              reason: "left-over",
              message: `${agent.name}'s old GitHub app was not fully removed. Delete it on GitHub, then dismiss it.`,
            });
          }
          // Without a keychain the hub would have nowhere but a file for the key, so it makes no app.
          if (!(yield* keys.usable)) {
            return yield* new HobAppRefused({
              reason: "no-keychain",
              message: "This hub has no keychain Hobbots can use, so it cannot keep a hob's GitHub app key.",
            });
          }
          return agent;
        });

      const start = (agentId: AgentId, deviceId: DeviceId, hubUrl: string) =>
        Effect.gen(function* () {
          const agent = yield* canGive(agentId);
          const state = Base64Url.encode(yield* random.randomBytes(STATE_BYTES));
          const hash = yield* hashOf(state);
          const expiresAt = (yield* Clock.currentTimeMillis) + STATE_TTL_MS;
          // A new start for the hob ends any earlier one.
          for (const [key, open] of states) if (open.agentId === agentId) states.delete(key);
          states.set(hash, {
            agentId,
            deviceId,
            hobName: agent.name,
            redirectUrl: `${hubUrl}${HOB_APP_CALLBACK_PATH}`,
            expiresAt,
          });
          return {
            url: `${hubUrl}${HOB_APP_NEW_PATH}?state=${encodeURIComponent(state)}`,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          };
        });

      /** The live state `state` names, or none; an expired one is dropped. */
      const live = (state: string) =>
        Effect.gen(function* () {
          const hash = yield* hashOf(state);
          const open = states.get(hash);
          if (open === undefined) return Option.none<{ hash: string; open: OpenState }>();
          if (open.expiresAt <= (yield* Clock.currentTimeMillis)) {
            states.delete(hash);
            return Option.none();
          }
          return Option.some({ hash, open });
        });

      const form = (state: string) =>
        Effect.map(
          live(state),
          Option.map(({ open }) => ({
            hobName: open.hobName,
            action: `${hosts.web}/settings/apps/new?state=${encodeURIComponent(state)}`,
            manifest: JSON.stringify(hobAppManifest(open.hobName, open.redirectUrl)),
          })),
        );

      const unknown = new HobAppNotMade({
        reason: "unknown",
        message: "This link is not one the hub opened, was already used, or expired.",
        deleteUrl: null,
      });
      const notKept = (message: string, slug: string | null) =>
        new HobAppNotMade({ reason: "failed", message, deleteUrl: slug === null ? null : deleteUrl(slug) });

      /** The bot's user ID, for its commit email; null when GitHub does not say, so #225 can ask again. */
      const botUserId = (slug: string) =>
        send(HttpClientRequest.get(`${hosts.api}/users/${encodeURIComponent(`${slug}[bot]`)}`), "the app's bot").pipe(
          Effect.flatMap((response) =>
            response.status === 200 ? read(response, UserJson, "the app's bot") : Effect.fail(null),
          ),
          Effect.map((user) => user.id),
          Effect.catch(() => Effect.succeed(null)),
        );

      const exchange = (open: OpenState, code: string) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${hosts.api}/app-manifests/${code}/conversions`),
            "the new app",
          ).pipe(Effect.mapError((error) => notKept(error.message, null)));
          if (response.status !== 201) {
            return yield* notKept(
              `GitHub answered ${response.status} when the hub asked for ${open.hobName}'s new app. The code may have expired: start again from the Charms tab.`,
              null,
            );
          }
          const made = yield* read(response, ConversionJson, "the new app").pipe(
            Effect.mapError((error) => notKept(error.message, null)),
          );
          // `client_secret` and `webhook_secret` are never read: the app has no user sign-in and no webhook.
          const pem = Redacted.make(made.pem);
          yield* remember(made.pem, `${open.hobName}'s GitHub app key`);
          return { made, pem };
        });

      const complete = (state: string, code: string) =>
        writing.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* live(state);
            if (Option.isNone(found) || !CODE.test(code)) return yield* unknown;
            // Used once, whatever happens next.
            states.delete(found.value.hash);
            const open = found.value.open;
            const { made, pem } = yield* exchange(open, code);
            const why = yield* refusalAfterMade(open);
            if (why !== null) return yield* notKept(why, made.slug);
            const app: HobGitHubApp = {
              appId: made.id,
              clientId: made.client_id,
              slug: made.slug,
              owner: made.owner.login,
              origin: "made",
              botUserId: yield* botUserId(made.slug),
              htmlUrl: made.html_url,
              connectedAt: DateTime.formatIso(yield* DateTime.now),
            };
            const unkept = yield* keep(
              open.agentId,
              app,
              pem,
              (message) =>
                `GitHub made the app, but the hub's keychain did not keep its key: ${message} Delete the app on GitHub, then try again.`,
            );
            if (unkept !== null) return yield* notKept(unkept, made.slug);
            yield* Effect.logInfo("A hob's GitHub app was made", { agentId: open.agentId, slug: app.slug });
            return { agentId: open.agentId, hobName: open.hobName, app, installUrl: installUrl(app) };
          }),
        );

      /**
       * Writes the app's key to the keychain, then gives the hob the app: the key is there before the
       * app counts as connected. Answers why the keychain did not keep it, or null once the hob has it.
       */
      const keep = (
        agentId: AgentId,
        app: HobGitHubApp,
        pem: Redacted.Redacted<string>,
        why: (message: string) => string,
      ) =>
        Effect.gen(function* () {
          const unkept = yield* keys.write(agentId, pem).pipe(
            Effect.as(null),
            Effect.catch((error: KeychainError) => Effect.succeed(error)),
          );
          if (unkept !== null) {
            const problem = why(unkept.message);
            // A write that failed may still have stored the key. Unless it is surely gone, the app
            // is kept as left over, so the hub still knows a key may be there (#948).
            const kept = yield* removeKey(agentId, true);
            if (kept !== null) {
              yield* Effect.uninterruptible(
                apps.save(agentId, app).pipe(Effect.andThen(apps.leave(agentId, `${problem} ${kept}`))),
              );
            }
            return problem;
          }
          // What the user allowed the hob to do on GitHub as them is not allowed as its bot (ADR 022).
          yield* grants.switchIdentity(GITHUB_CHARM, agentId, apps.save(agentId, app));
          yield* tokens.forget(agentId);
          return null;
        });

      const linkRefused = (reason: HobAppRefused["reason"], message: string) => new HobAppRefused({ reason, message });

      /** The app a JWT signed with `pem` signs in as, from `GET /app` (#1321). */
      const appOfKey = (id: string, pem: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          const jwt = yield* appJwt(id, pem).pipe(
            Effect.mapError(() =>
              linkRefused(
                "not-a-key",
                "That is not a GitHub app private key. Paste the whole .pem file GitHub gave you.",
              ),
            ),
          );
          yield* remember(Redacted.value(jwt), "a linked GitHub app's sign-in");
          const unreachable = (message: string) => linkRefused("unreachable", message);
          const response = yield* send(asApp("/app", jwt), "the app").pipe(
            Effect.mapError((error) => unreachable(error.message)),
          );
          if (response.status === 401) {
            return yield* linkRefused(
              "key-refused",
              "GitHub did not accept this key for that app. Check the app ID, or generate a new private key in the app's settings on GitHub.",
            );
          }
          if (response.status !== 200) return yield* unreachable(`GitHub answered ${response.status} for the app.`);
          const found = yield* read(response, AppJson, "the app").pipe(
            Effect.mapError((error) => unreachable(error.message)),
          );
          // GitHub signs in only the key's own app, so a JWT for another ID is refused above; this checks it again.
          if (String(found.id) !== id && found.client_id !== id) {
            return yield* linkRefused("key-refused", "This key belongs to another GitHub app than the ID you gave.");
          }
          return found;
        });

      const link = (agentId: AgentId, request: HobAppLinkRequest) =>
        writing.withPermits(1)(
          Effect.gen(function* () {
            const agent = yield* canGive(agentId);
            const id = request.appId.trim();
            if (!APP_ID.test(id)) {
              return yield* linkRefused(
                "bad-id",
                "Give the App ID or the Client ID from the app's settings on GitHub.",
              );
            }
            const text = Redacted.value(request.privateKey).trim();
            // Redacted before anything else reads it, so no failure below can show it.
            yield* remember(text, `${agent.name}'s GitHub app key`);
            const pem = Redacted.make(`${text}\n`);
            const found = yield* appOfKey(id, pem);
            const holder = yield* apps.holder(found.id);
            if (holder !== null) {
              return yield* linkRefused(
                "taken",
                `${found.slug} is already another hob's app. One app is one hob's name.`,
              );
            }
            const app: HobGitHubApp = {
              appId: found.id,
              clientId: found.client_id,
              slug: found.slug,
              owner: found.owner?.login ?? "",
              origin: "linked",
              botUserId: yield* botUserId(found.slug),
              htmlUrl: found.html_url,
              connectedAt: DateTime.formatIso(yield* DateTime.now),
            };
            const unkept = yield* keep(
              agentId,
              app,
              pem,
              (message) => `The hub's keychain did not keep the app's key: ${message} Try again.`,
            );
            if (unkept !== null) return yield* linkRefused("keychain-failed", unkept);
            yield* Effect.logInfo("A hob's GitHub app was linked", { agentId, slug: app.slug });
            return { app, bot: hobAppBot(app), missingPermissions: missingPermissions(found.permissions) };
          }),
        );

      /** Why the hob cannot keep an app GitHub just made, or null when it can. */
      const refusalAfterMade = (open: OpenState) =>
        Effect.gen(function* () {
          const device = yield* devices.find(open.deviceId);
          if (Option.isNone(device) || device.value.revokedAt !== null) {
            return "The device that asked for this app was removed from the hub meanwhile, so the hub did not keep it.";
          }
          const agent = yield* hobs.findAgent(open.agentId);
          if (Option.isNone(agent) || agent.value.status === "retired") {
            return `${open.hobName} was retired meanwhile, so the hub did not keep the app.`;
          }
          if ((yield* apps.get(open.agentId)) !== null) {
            return `${open.hobName} already has its own GitHub app, so the hub did not keep this one.`;
          }
          // An old app not fully removed stays shown until dismissed; a new one would replace it.
          if ((yield* apps.leftOver(open.agentId)) !== null) {
            return `${open.hobName}'s old GitHub app was not fully removed, so the hub did not keep this one.`;
          }
          return null;
        });

      /** A JWT for the hob's app, from the key in the keychain. */
      const jwtFor = (agentId: AgentId, app: HobGitHubApp) =>
        Effect.gen(function* () {
          const key = yield* keys.read(agentId).pipe(
            Effect.mapError((error) => new GitHubError({ reason: "failed", message: error.message })),
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  Effect.fail(
                    new GitHubError({
                      reason: "signed-out",
                      message: `The hub's keychain did not give back ${hobAppBot(app)}'s key. Unlock it, or give the hob a new app.`,
                    }),
                  ),
              }),
            ),
          );
          const jwt = yield* appJwt(app.clientId, key);
          yield* remember(Redacted.value(jwt), `${hobAppBot(app)} sign-in`);
          return jwt;
        });

      const asApp = (path: string, jwt: Redacted.Redacted<string>, params: Record<string, string> = {}) =>
        HttpClientRequest.get(`${hosts.api}${path}`, { urlParams: params }).pipe(
          HttpClientRequest.bearerToken(Redacted.value(jwt)),
        );

      const tokens = yield* makeHobAppTokens({ hosts, send, read, jwtFor, remember, installUrl });

      // A token that may only read the repositories' names, kept until five minutes before it lapses, so
      // reading where the app is installed every few seconds mints one an hour for each installation.
      const namesTokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

      /** A token for one installation that reads metadata only, which reaches all its repositories. */
      const namesToken = (agentId: AgentId, app: HobGitHubApp, installation: number, jwt: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          const key = `${agentId}:${app.appId}:${installation}`;
          const now = yield* Clock.currentTimeMillis;
          const kept = namesTokens.get(key);
          if (kept !== undefined && kept.expiresAt - NAMES_TOKEN_AHEAD_MS > now) return kept.token;
          const response = yield* send(
            HttpClientRequest.post(`${hosts.api}/app/installations/${installation}/access_tokens`).pipe(
              HttpClientRequest.bearerToken(Redacted.value(jwt)),
              HttpClientRequest.bodyJsonUnsafe({ permissions: { metadata: "read" } }),
            ),
            "the names of the app's repositories",
          );
          if (response.status === 401) return yield* Effect.flip(tokens.keyRefused(agentId, app));
          if (response.status !== 201) return yield* answered(response.status, "the names of the app's repositories");
          const json = yield* read(response, AccessTokenJson, "the names of the app's repositories");
          yield* remember(json.token, `${hobAppBot(app)} token`);
          namesTokens.set(key, { token: json.token, expiresAt: Date.parse(json.expires_at) });
          return json.token;
        });

      /** The repositories one installation reaches, as `owner/name`: `GET /installation/repositories`. */
      const reached = (agentId: AgentId, app: HobGitHubApp, installation: number, jwt: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          const token = yield* namesToken(agentId, app, installation, jwt);
          const listed = yield* allPages((page) =>
            send(
              HttpClientRequest.get(`${hosts.api}/installation/repositories`, {
                urlParams: { per_page: String(GITHUB_PAGE_SIZE), page: String(page) },
              }).pipe(HttpClientRequest.bearerToken(token)),
              "the names of the app's repositories",
            ).pipe(
              Effect.flatMap((response) =>
                response.status === 200
                  ? read(response, InstallationRepositoriesJson, "the names of the app's repositories")
                  : Effect.fail(answeredError(response.status, "the names of the app's repositories")),
              ),
              Effect.map((body) => body.repositories),
            ),
          ).pipe(
            // A token GitHub stops taking is not used again; the next read mints another.
            Effect.tapError(() => Effect.sync(() => namesTokens.delete(`${agentId}:${app.appId}:${installation}`))),
          );
          return listed.map((repository) => repository.full_name);
        });

      const listInstallations = (agentId: AgentId, app: HobGitHubApp, jwt: Redacted.Redacted<string>) =>
        allPages((page) =>
          send(
            asApp("/app/installations", jwt, { per_page: String(GITHUB_PAGE_SIZE), page: String(page) }),
            "the app's installations",
          ).pipe(
            Effect.flatMap((response) => {
              if (response.status === 401) return Effect.flip(tokens.keyRefused(agentId, app));
              if (response.status !== 200) return answered(response.status, "the app's installations");
              return read(response, Schema.Array(InstallationJson), "the app's installations");
            }),
          ),
        );

      /**
       * Where the app is installed, with the repositories each reaches. Only this display needs the names;
       * removing the installations needs only their IDs, so a name GitHub will not give never keeps one.
       */
      const named = (
        agentId: AgentId,
        app: HobGitHubApp,
        jwt: Redacted.Redacted<string>,
        listed: ReadonlyArray<typeof InstallationJson.Type>,
      ) =>
        Effect.forEach(
          listed,
          (installation) =>
            Effect.gen(function* () {
              const suspended = installation.suspended_at != null;
              return {
                id: installation.id,
                account: installation.account?.login ?? app.owner,
                repositorySelection: installation.repository_selection,
                htmlUrl: installation.html_url,
                suspended,
                repositories: suspended ? null : yield* reached(agentId, app, installation.id, jwt),
                // GitHub lists what an installation grants; one that lists nothing is not judged.
                missingPermissions:
                  installation.permissions === undefined ? [] : missingPermissions(installation.permissions),
              } satisfies HobGitHubAppInstallation;
            }),
          { concurrency: 4 },
        );

      /** Reads the hob's app as itself with `use`, or answers nothing when it has none. */
      const asHobApp = <A, E, R>(
        agentId: AgentId,
        use: (app: HobGitHubApp, jwt: Redacted.Redacted<string>) => Effect.Effect<ReadonlyArray<A>, E, R>,
      ) =>
        Effect.gen(function* () {
          yield* agentOf(agentId);
          const app = yield* apps.get(agentId);
          if (app === null) return [];
          return yield* use(app, yield* jwtFor(agentId, app));
        });

      const installations = (agentId: AgentId) =>
        asHobApp(agentId, (app, jwt) =>
          Effect.gen(function* () {
            const listed = yield* listInstallations(agentId, app, jwt);
            yield* tokens.settled(
              agentId,
              app,
              listed.some((installation) => installation.suspended_at == null),
            );
            return yield* named(agentId, app, jwt, listed);
          }),
        );

      /**
       * The permissions the hob's actions use that the app itself lacks, from `GET /app`: what an app
       * installed nowhere yet still needs, which no installation can say (#1321).
       */
      const appMissing = (agentId: AgentId) =>
        asHobApp(agentId, (app, jwt) =>
          Effect.gen(function* () {
            const response = yield* send(asApp("/app", jwt), "the app");
            if (response.status === 401) return yield* Effect.flip(tokens.keyRefused(agentId, app));
            if (response.status !== 200) return yield* answered(response.status, "the app");
            const found = yield* read(response, AppJson, "the app");
            return missingPermissions(found.permissions);
          }),
        );

      /** Removes every installation of the app, so it reaches no repository even with a leaked key. */
      const uninstall = (agentId: AgentId, app: HobGitHubApp) =>
        Effect.gen(function* () {
          const jwt = yield* jwtFor(agentId, app);
          const listed = yield* listInstallations(agentId, app, jwt);
          const left = yield* Effect.forEach(listed, (installation) =>
            send(
              HttpClientRequest.delete(`${hosts.api}/app/installations/${installation.id}`).pipe(
                HttpClientRequest.bearerToken(Redacted.value(jwt)),
              ),
              "removing an installation",
            ).pipe(
              // 404: already gone.
              Effect.map((response) => (response.status === 204 || response.status === 404 ? [] : [installation])),
              Effect.catch(() => Effect.succeed([installation])),
            ),
          );
          const count = left.flat().length;
          return count === 0
            ? null
            : `${count} of the app's installations could not be removed. Delete the app on GitHub to close them.`;
        }).pipe(
          Effect.catch((error: GitHubError) =>
            Effect.succeed(
              `The hub could not remove the app's installations: ${error.message} Delete the app on GitHub to close them.`,
            ),
          ),
        );

      /**
       * Deletes the hob's key, answering why it may still be in the keychain, or null when it is gone.
       * `recorded`: whether the hub has the hob's app, left over or not, so it stored a key.
       */
      const removeKey = (agentId: AgentId, recorded: boolean) =>
        keys.remove(agentId).pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(deleteOutcome(error, recorded, "the app's key"))),
        );

      /** `dismiss`: whether a left-over app is dismissed, which only the user's disconnect does. */
      const disconnectHob = (agentId: AgentId, dismiss: boolean) =>
        writing.withPermits(1)(
          Effect.gen(function* () {
            // Its tokens are never used again, whatever is left to remove.
            yield* tokens.forget(agentId);
            const app = yield* apps.get(agentId);
            if (app === null) {
              // A key without its app is removed too, so nothing is left behind.
              const left = yield* apps.leftOver(agentId);
              const keyKept = yield* removeKey(agentId, left !== null);
              // Disconnecting a left-over app dismisses it. Without its key the hub cannot try its
              // installations again; only deleting the app on GitHub closes what is left.
              if (left === null) return { deleteUrl: null, problem: null, keyKept };
              const leftAt = left.app.origin === "linked" ? null : deleteUrl(left.app.slug);
              if (!dismiss) return { deleteUrl: leftAt, problem: left.problem, keyKept };
              yield* apps.remove(agentId);
              return { deleteUrl: leftAt, problem: null, keyKept };
            }
            // Tried once and shown, never retried in a loop (ADR 022). The hub did not make a linked
            // app, so its installations stay as the user set them on GitHub (#1321).
            const problem = app.origin === "linked" ? null : yield* uninstall(agentId, app);
            const deleteAt = app.origin === "linked" ? null : deleteUrl(app.slug);
            const kept = yield* removeKey(agentId, true);
            const problems = [problem, kept].filter((each) => each !== null);
            // The hob acts as the bot until here, then as the user: nothing allowed for its bot runs as
            // them, and no request it asked as the bot saves a grant for them (ADR 022).
            if (problems.length === 0) {
              yield* grants.switchIdentity(GITHUB_CHARM, agentId, apps.remove(agentId));
              yield* Effect.logInfo("A hob's GitHub app was disconnected", { agentId, slug: app.slug });
              return { deleteUrl: deleteAt, problem: null, keyKept: null };
            }
            // Kept as left over, so the problem and where to delete the app stay shown (ADR 022).
            const left = problems.join(" ");
            yield* grants.switchIdentity(GITHUB_CHARM, agentId, apps.leave(agentId, left));
            yield* Effect.logWarning("A hob's GitHub app was not fully removed", { agentId, slug: app.slug });
            return { deleteUrl: deleteAt, problem: left, keyKept: kept };
          }),
        );

      const disconnect = (agentId: AgentId) =>
        Effect.andThen(agentOf(agentId), disconnectHob(agentId, true)).pipe(
          Effect.map(({ deleteUrl, problem }) => ({ deleteUrl, problem })),
        );

      const service = HobGitHubAppService.of({
        status,
        start,
        form,
        complete,
        link,
        installations,
        appMissing,
        disconnect,
      });
      const retired = RetiredHobGitHubApp.of({
        remove: (agentId) =>
          // What could not be removed stays with the hob's app as left over, shown by its status.
          // Retiring again leaves it as it is.
          disconnectHob(agentId, false).pipe(Effect.asVoid),
        erase: (agentId) => disconnectHob(agentId, false).pipe(Effect.map((result) => result.keyKept)),
      });
      return Context.make(HobGitHubAppService, service).pipe(
        Context.add(RetiredHobGitHubApp, retired),
        Context.add(HobAppTokens, tokens),
      );
    }),
  ).pipe(Layer.provide([SecureRandom.layerWebCrypto, Digest.layerWebCrypto]));

/** A hob's own GitHub App with the hub's own `fetch`. */
export const HobGitHubAppNode = (hosts?: GitHubHosts) =>
  HobGitHubAppLive(hosts).pipe(Layer.provide(FetchHttpClient.layer));
