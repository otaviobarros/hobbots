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
  hobAppBot,
} from "@hobbots/domain";
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { sendToGitHub } from "./github-api.ts";
import { appJwt } from "./github-app-jwt.ts";
import { GitHubError } from "./github-error.ts";
import { allPages, GITHUB_HOSTS, GITHUB_PAGE_SIZE, type GitHubHosts } from "./github-sign-in.ts";
import { type HobAppReconnect, HobAppTokens, makeHobAppTokens } from "./hob-app-tokens.ts";
import { HobAppKeys, type KeychainError } from "./keychain.ts";

/**
 * A hob's own GitHub App (#223, ADR 022), made from a manifest so the user never fills in an app's
 * settings or handles a key file. The hub page posts the manifest to GitHub, GitHub redirects back
 * to the hub with a code, and the hub exchanges it for the app's identity and private key. The key
 * goes to the OS keychain; GitHub's client and webhook secrets are dropped at once. The hub signs in
 * as the app with a JWT to list and remove its installations, and to mint its tokens (#224).
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

/** Why making a hob's app did not start. */
export class HobAppRefused extends Schema.TaggedError<HobAppRefused>()("HobAppRefused", {
  reason: Schema.Literals(["not-found", "retired", "connected", "left-over", "no-keychain"]),
  message: Schema.String,
}) {}

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
    /** Removes the app's installations, then its key, then forgets it. */
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
  url: "https://hobbots.ai",
  description: `${hobName}'s identity on GitHub, made by Hobbots for this hob alone. It acts only where you install it.`,
  public: false,
  default_permissions: HOB_APP_PERMISSIONS,
  default_events: [],
  // GitHub asks for a webhook URL; the app subscribes to no event and its webhook stays off.
  hook_attributes: { url: "https://hobbots.ai", active: false },
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
const InstallationJson = Schema.Struct({
  id: Schema.Number,
  account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  repository_selection: Schema.Literals(["all", "selected"]),
  html_url: Schema.String,
  suspended_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

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

      const start = (agentId: AgentId, deviceId: DeviceId, hubUrl: string) =>
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
            // The key is in the keychain before the hob's app counts as connected.
            yield* keys
              .write(open.agentId, pem)
              .pipe(
                Effect.mapError((error: KeychainError) =>
                  notKept(
                    `GitHub made the app, but the hub's keychain did not keep its key: ${error.message} Delete the app on GitHub, then try again.`,
                    made.slug,
                  ),
                ),
              );
            const app: HobGitHubApp = {
              appId: made.id,
              clientId: made.client_id,
              slug: made.slug,
              owner: made.owner.login,
              botUserId: yield* botUserId(made.slug),
              htmlUrl: made.html_url,
              connectedAt: DateTime.formatIso(yield* DateTime.now),
            };
            // What the user allowed the hob to do on GitHub as them is not allowed as its bot (ADR 022).
            yield* grants.revokeGitHub(open.agentId);
            yield* apps.save(open.agentId, app);
            yield* tokens.forget(open.agentId);
            yield* Effect.logInfo("A hob's GitHub app was made", { agentId: open.agentId, slug: app.slug });
            return { hobName: open.hobName, app, installUrl: installUrl(app) };
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

      const listInstallations = (agentId: AgentId, app: HobGitHubApp, jwt: Redacted.Redacted<string>) =>
        allPages((page) =>
          send(
            asApp("/app/installations", jwt, { per_page: String(GITHUB_PAGE_SIZE), page: String(page) }),
            "the app's installations",
          ).pipe(
            Effect.flatMap((response) => {
              if (response.status === 401) return Effect.flip(tokens.keyRefused(agentId, app));
              if (response.status !== 200) {
                return Effect.fail(
                  new GitHubError({
                    reason: "failed",
                    message: `GitHub answered ${response.status} for the app's installations.`,
                  }),
                );
              }
              return read(response, Schema.Array(InstallationJson), "the app's installations");
            }),
          ),
        ).pipe(
          Effect.map((listed) =>
            listed.map(
              (installation): HobGitHubAppInstallation => ({
                id: installation.id,
                account: installation.account?.login ?? app.owner,
                repositorySelection: installation.repository_selection,
                htmlUrl: installation.html_url,
                suspended: installation.suspended_at != null,
              }),
            ),
          ),
        );

      const installations = (agentId: AgentId) =>
        Effect.gen(function* () {
          yield* agentOf(agentId);
          const app = yield* apps.get(agentId);
          if (app === null) return [];
          const listed = yield* listInstallations(agentId, app, yield* jwtFor(agentId, app));
          yield* tokens.settled(
            agentId,
            listed.some((installation) => !installation.suspended),
          );
          return listed;
        });

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

      /** `dismiss`: whether a left-over app is dismissed, which only the user's disconnect does. */
      const disconnectHob = (agentId: AgentId, dismiss: boolean) =>
        writing.withPermits(1)(
          Effect.gen(function* () {
            // Its tokens are never used again, whatever is left to remove.
            yield* tokens.forget(agentId);
            const app = yield* apps.get(agentId);
            if (app === null) {
              // A key without its app is removed too, so nothing is left behind.
              yield* keys.remove(agentId).pipe(Effect.ignore);
              // Disconnecting a left-over app dismisses it. Without its key the hub cannot try its
              // installations again; only deleting the app on GitHub closes what is left.
              const left = yield* apps.leftOver(agentId);
              if (left === null) return { deleteUrl: null, problem: null };
              if (!dismiss) return { deleteUrl: deleteUrl(left.app.slug), problem: left.problem };
              yield* apps.remove(agentId);
              return { deleteUrl: deleteUrl(left.app.slug), problem: null };
            }
            // Before the hob acts as the user again: nothing allowed for its bot runs as them (ADR 022).
            yield* grants.revokeGitHub(agentId);
            // Tried once and shown, never retried in a loop (ADR 022).
            const problem = yield* uninstall(agentId, app);
            const kept = yield* keys.remove(agentId).pipe(
              Effect.as(null),
              Effect.catch((error) =>
                Effect.succeed(`The hub's keychain did not delete the app's key: ${error.message}`),
              ),
            );
            const problems = [problem, kept].filter((each) => each !== null);
            if (problems.length === 0) {
              yield* apps.remove(agentId);
              yield* Effect.logInfo("A hob's GitHub app was disconnected", { agentId, slug: app.slug });
              return { deleteUrl: deleteUrl(app.slug), problem: null };
            }
            // Kept as left over, so the problem and where to delete the app stay shown (ADR 022).
            const left = problems.join(" ");
            yield* apps.leave(agentId, left);
            yield* Effect.logWarning("A hob's GitHub app was not fully removed", { agentId, slug: app.slug });
            return { deleteUrl: deleteUrl(app.slug), problem: left };
          }),
        );

      const disconnect = (agentId: AgentId) => Effect.andThen(agentOf(agentId), disconnectHob(agentId, true));

      const service = HobGitHubAppService.of({ status, start, form, complete, installations, disconnect });
      const retired = RetiredHobGitHubApp.of({
        remove: (agentId) =>
          // What could not be removed stays with the hob's app as left over, shown by its status.
          // Retiring again leaves it as it is.
          disconnectHob(agentId, false).pipe(Effect.asVoid),
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
