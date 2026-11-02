import { type AgentId, type HobGitHubApp, hobAppBot, repositorySlug } from "@hobbots/domain";
import { Cache, Clock, Context, Effect, Exit, Redacted, Schema, Semaphore } from "effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { GitHubAction, GitHubTokenScope } from "./github-account.ts";
import { GitHubError } from "./github-error.ts";
import type { GitHubHosts } from "./github-sign-in.ts";

/**
 * Installation tokens for a hob's own GitHub App (#224, ADR 022). The hub signs a JWT with the hob's
 * key, finds the app's installation for the repository, and asks for a token scoped to that one
 * repository and to the permissions the action needs. Tokens live in memory only, until five minutes
 * before GitHub retires them. A revoked key or tokens GitHub keeps refusing mark the app as needing a
 * reconnect, and its calls fail with that reason, never sent again blindly, until the user acts.
 */

/** Why a hob's app cannot act until the user fixes it: a new app for `key`, reinstalling it for `installation`. */
export interface HobAppReconnect {
  readonly reason: "key" | "installation";
  readonly message: string;
}

type Permissions = Readonly<Record<string, "read" | "write">>;

/** The permissions each action asks for (ADR 022), by GitHub's names. */
export const ACTION_PERMISSIONS: Readonly<Record<GitHubAction, Permissions>> = {
  read: {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    checks: "read",
    actions: "read",
    statuses: "read",
  },
  push: { metadata: "read", contents: "write" },
  "push-workflows": { metadata: "read", contents: "write", workflows: "write" },
  "open-pull-request": { metadata: "read", pull_requests: "write", contents: "read" },
  comment: { metadata: "read", issues: "write", pull_requests: "write" },
};

/** A token this close to expiry is replaced on its next use. */
const REPLACE_AHEAD_MS = 5 * 60_000;

const InstallationJson = Schema.Struct({
  id: Schema.Number,
  suspended_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const AccessTokenJson = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

/** What the token source borrows from the hob's app service. */
export interface HobAppTokenDeps {
  readonly hosts: GitHubHosts;
  readonly send: (
    request: HttpClientRequest.HttpClientRequest,
    what: string,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, GitHubError>;
  readonly read: <S extends Schema.Constraint>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
    what: string,
  ) => Effect.Effect<S["Type"], GitHubError, S["DecodingServices"]>;
  readonly jwtFor: (agentId: AgentId, app: HobGitHubApp) => Effect.Effect<Redacted.Redacted<string>, GitHubError>;
  readonly remember: (value: string, kind: string) => Effect.Effect<void>;
  readonly installUrl: (app: HobGitHubApp) => string;
}

/** A token, or why there is none. */
type TokenOrWhy = Effect.Effect<Redacted.Redacted<string>, GitHubError>;
type Repository = GitHubTokenScope["repository"];

/** The hob's app as a source of tokens, which `GitHubCredentialPerHob` puts behind `GitHubCredential`. */
export class HobAppTokens extends Context.Service<
  HobAppTokens,
  {
    /** A token for `scope`, from memory while it has more than five minutes left. */
    readonly token: (agentId: AgentId, app: HobGitHubApp, scope: GitHubTokenScope) => TokenOrWhy;
    /** Whether the hub minted `token` for a hob's app. */
    readonly owns: (token: Redacted.Redacted<string>) => boolean;
    /** After GitHub refused `token` (401): a new one for the same scope, minted at most once. */
    readonly refused: (agentId: AgentId, app: HobGitHubApp, token: Redacted.Redacted<string>) => TokenOrWhy;
    /** GitHub refused a new token too: the app needs reinstalling. */
    readonly revoked: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
    /** Fails unless the app is installed on `repository`, as GitHub said within the last minute. */
    readonly reaches: (agentId: AgentId, app: HobGitHubApp, repository: Repository) => Effect.Effect<void, GitHubError>;
    /** Why the hob's app needs a reconnect, or null. */
    readonly reconnect: (agentId: AgentId, app: HobGitHubApp) => HobAppReconnect | null;
    /**
     * GitHub took the app's key again, as when it lists the app's installations: that ends a `key`
     * mark, and an `installation` one too once the app is installed somewhere.
     */
    readonly settled: (agentId: AgentId, installed: boolean) => Effect.Effect<void>;
    /** GitHub refused the app's key outside a call. */
    readonly keyRefused: (agentId: AgentId, app: HobGitHubApp) => Effect.Effect<GitHubError>;
    /** Drops everything kept for the hob, when its app is replaced or removed. */
    readonly forget: (agentId: AgentId) => Effect.Effect<void>;
  }
>()("@hobbots/charms/HobAppTokens") {}

interface Minted {
  readonly token: Redacted.Redacted<string>;
  /** How long the hub keeps it, in milliseconds. */
  readonly keepMs: number;
}

interface Issued {
  readonly agentId: AgentId;
  readonly appId: number;
  readonly key: string;
}

/** A cache key for one hob, app, repository and action, read back by the cache's lookup. */
const keyOf = (agentId: AgentId, app: HobGitHubApp, scope: GitHubTokenScope) =>
  JSON.stringify([agentId, app.appId, scope.repository.owner, scope.repository.name, scope.action]);
const installationKeyOf = (agentId: AgentId, app: HobGitHubApp, repository: Repository) =>
  JSON.stringify([agentId, app.appId, repository.owner.toLowerCase(), repository.name.toLowerCase()]);

const changed = new GitHubError({
  reason: "signed-out",
  message: "The hob's GitHub sign-in changed during this call, so it did not run. Try again.",
});

export const makeHobAppTokens = (deps: HobAppTokenDeps) =>
  Effect.gen(function* () {
    const { hosts, send, read, jwtFor, remember } = deps;
    // The app each lookup is for, by its key, so the cache's lookup needs only the key.
    const appsByKey = new Map<string, { readonly agentId: AgentId; readonly app: HobGitHubApp }>();
    const marks = new Map<AgentId, { readonly appId: number; readonly why: HobAppReconnect }>();
    // Every live token by its value, and the newest one for each key, so a refusal names its scope.
    const issued = new Map<string, Issued>();
    const newest = new Map<string, string>();
    // A refused token is replaced by one call only; the others take the replacement.
    const renewing = yield* Semaphore.make(1);

    const bot = (app: HobGitHubApp) => hobAppBot(app);

    const keyRefused = (agentId: AgentId, app: HobGitHubApp) =>
      Effect.sync(() => {
        const message = `GitHub refused ${bot(app)}'s key: the app may have been deleted, or its key revoked. Give the hob a new app from its Charms tab.`;
        marks.set(agentId, { appId: app.appId, why: { reason: "key", message } });
        return new GitHubError({ reason: "signed-out", message });
      });

    const markInstallation = (agentId: AgentId, app: HobGitHubApp) =>
      Effect.sync(() => {
        const message = `GitHub refused ${bot(app)}'s tokens: the app may have been uninstalled or suspended. Install it again at ${deps.installUrl(app)}, then open the hob's Charms tab.`;
        marks.set(agentId, { appId: app.appId, why: { reason: "installation", message } });
      });

    const reconnect = (agentId: AgentId, app: HobGitHubApp) => {
      const mark = marks.get(agentId);
      return mark !== undefined && mark.appId === app.appId ? mark.why : null;
    };

    /** Fails with why the app needs a reconnect, so nothing is sent while it does. */
    const unmarked = (agentId: AgentId, app: HobGitHubApp) => {
      const why = reconnect(agentId, app);
      return why === null ? Effect.void : Effect.fail(new GitHubError({ reason: "signed-out", message: why.message }));
    };

    const failed = (status: number, what: string) =>
      new GitHubError({ reason: "failed", message: `GitHub answered ${status} for ${what}.` });

    const notInstalled = (app: HobGitHubApp, repository: Repository) =>
      new GitHubError({
        reason: "not-found",
        message: `${bot(app)} is not installed on ${repositorySlug(repository)}, so it cannot act there. Install the hob's app on that repository at ${deps.installUrl(app)}, then try again.`,
      });

    /** The app's installation for one repository: `GET /repos/{owner}/{repo}/installation` with a JWT. */
    const findInstallation = (key: string) =>
      Effect.gen(function* () {
        const [agentId, , owner, name] = JSON.parse(key) as [AgentId, number, string, string];
        const found = appsByKey.get(key);
        if (found === undefined) return yield* changed;
        const { app } = found;
        const repository = { owner, name };
        const jwt = yield* jwtFor(agentId, app);
        const response = yield* send(
          HttpClientRequest.get(
            `${hosts.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
          ).pipe(HttpClientRequest.bearerToken(Redacted.value(jwt))),
          "the app's installation",
        );
        if (response.status === 401) return yield* Effect.flip(keyRefused(agentId, app));
        if (response.status === 404) return yield* notInstalled(app, repository);
        if (response.status !== 200) return yield* failed(response.status, "the app's installation");
        const installation = yield* read(response, InstallationJson, "the app's installation");
        if (installation.suspended_at != null) {
          return yield* new GitHubError({
            reason: "signed-out",
            message: `${bot(app)} is suspended on GitHub, so it cannot act on ${repositorySlug(repository)}. Unsuspend it in its installation settings on GitHub.`,
          });
        }
        return installation.id;
      });

    // Read again at most a minute later, so uninstalling the app closes a repository within a minute.
    // A failure is not kept, so the next call asks GitHub again.
    const installations = yield* Cache.makeWith(findInstallation, {
      capacity: 1_000,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 minute" : 0),
    });

    const installationOf = (agentId: AgentId, app: HobGitHubApp, repository: Repository) =>
      Effect.gen(function* () {
        const key = installationKeyOf(agentId, app, repository);
        appsByKey.set(key, { agentId, app });
        return yield* Cache.get(installations, key);
      });

    /** One token: `POST /app/installations/{id}/access_tokens` for one repository and the action's permissions. */
    const mint = (key: string) =>
      Effect.gen(function* () {
        const [agentId, , owner, name, action] = JSON.parse(key) as [AgentId, number, string, string, GitHubAction];
        const found = appsByKey.get(key);
        if (found === undefined) return yield* changed;
        const { app } = found;
        const repository = { owner, name };
        const installation = yield* installationOf(agentId, app, repository);
        const jwt = yield* jwtFor(agentId, app);
        const response = yield* send(
          HttpClientRequest.post(`${hosts.api}/app/installations/${installation}/access_tokens`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(jwt)),
            HttpClientRequest.bodyJsonUnsafe({ repositories: [name], permissions: ACTION_PERMISSIONS[action] }),
          ),
          "a token for the hob's app",
        );
        if (response.status === 401) return yield* Effect.flip(keyRefused(agentId, app));
        if (response.status === 404 || response.status === 422) {
          // The installation went away, or no longer reaches the repository: GitHub is asked again next time.
          yield* Cache.invalidate(installations, installationKeyOf(agentId, app, repository));
          if (response.status === 404) return yield* notInstalled(app, repository);
          return yield* new GitHubError({
            reason: "not-found",
            message: `GitHub would not give ${bot(app)} a token for ${repositorySlug(repository)}: the app may not be installed there, or not have the permissions this needs. Check its installation at ${deps.installUrl(app)}.`,
          });
        }
        if (response.status === 403) {
          return yield* new GitHubError({
            reason: "signed-out",
            message: `GitHub refused ${bot(app)} a token for ${repositorySlug(repository)} (403): its installation may be suspended. Check it at ${deps.installUrl(app)}.`,
          });
        }
        if (response.status !== 201) return yield* failed(response.status, "a token for the hob's app");
        const json = yield* read(response, AccessTokenJson, "a token for the hob's app");
        yield* remember(json.token, `${bot(app)} token`);
        const now = yield* Clock.currentTimeMillis;
        const token = Redacted.make(json.token);
        const previous = newest.get(key);
        if (previous !== undefined) issued.delete(previous);
        issued.set(json.token, { agentId, appId: app.appId, key });
        newest.set(key, json.token);
        return { token, keepMs: Math.max(Date.parse(json.expires_at) - REPLACE_AHEAD_MS - now, 0) } satisfies Minted;
      });

    // Concurrent calls for one key share one lookup, so two calls at once mint one token.
    const tokens = yield* Cache.makeWith(mint, {
      capacity: 1_000,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.keepMs : 0),
    });

    const token = (agentId: AgentId, app: HobGitHubApp, scope: GitHubTokenScope) =>
      Effect.gen(function* () {
        yield* unmarked(agentId, app);
        const key = keyOf(agentId, app, scope);
        appsByKey.set(key, { agentId, app });
        return (yield* Cache.get(tokens, key)).token;
      });

    const refused = (agentId: AgentId, app: HobGitHubApp, token: Redacted.Redacted<string>) =>
      renewing.withPermits(1)(
        Effect.gen(function* () {
          yield* unmarked(agentId, app);
          const was = issued.get(Redacted.value(token));
          if (was === undefined || was.agentId !== agentId || was.appId !== app.appId) return yield* changed;
          // Another call may have replaced it while this one waited.
          if (newest.get(was.key) === Redacted.value(token)) yield* Cache.invalidate(tokens, was.key);
          return (yield* Cache.get(tokens, was.key)).token;
        }),
      );

    const revoked = (token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const was = issued.get(Redacted.value(token));
        if (was === undefined) return;
        issued.delete(Redacted.value(token));
        yield* Cache.invalidate(tokens, was.key);
        const found = appsByKey.get(was.key);
        if (found === undefined || found.app.appId !== was.appId) return;
        yield* markInstallation(was.agentId, found.app);
        yield* Effect.logWarning("GitHub refused a hob's app tokens; it needs a reconnect", { agentId: was.agentId });
      });

    const reaches = (agentId: AgentId, app: HobGitHubApp, repository: Repository) =>
      Effect.gen(function* () {
        yield* unmarked(agentId, app);
        yield* installationOf(agentId, app, repository);
      });

    const dropFor = (agentId: AgentId) =>
      Effect.gen(function* () {
        for (const [key, found] of appsByKey) {
          if (found.agentId !== agentId) continue;
          appsByKey.delete(key);
          yield* Cache.invalidate(tokens, key);
          yield* Cache.invalidate(installations, key);
        }
        for (const [value, was] of issued) {
          if (was.agentId !== agentId) continue;
          issued.delete(value);
          newest.delete(was.key);
        }
      });

    return HobAppTokens.of({
      token,
      owns: (token) => issued.has(Redacted.value(token)),
      refused,
      revoked,
      reaches,
      reconnect,
      settled: (agentId, installed) =>
        Effect.sync(() => {
          if (installed || marks.get(agentId)?.why.reason === "key") marks.delete(agentId);
        }),
      keyRefused,
      forget: (agentId) =>
        Effect.gen(function* () {
          marks.delete(agentId);
          yield* dropFor(agentId);
        }),
    });
  });
