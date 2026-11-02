import type { GitHubReachableRepository } from "@hobbots/domain";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * Signing in to GitHub as a GitHub App user with the device flow, and refreshing that sign-in
 * (ADR 020). Neither needs the app's client secret, so the hub holds none.
 */

/** Why the device flow or a refresh did not give the hub a sign-in, in words for the person. */
export class GitHubSignInError extends Schema.TaggedError<GitHubSignInError>()("GitHubSignInError", {
  /** `expired`: the code lapsed. `denied`: the person said no. `refused`: GitHub will not refresh. */
  reason: Schema.Literals(["expired", "denied", "refused", "failed"]),
  message: Schema.String,
}) {}

/** What the person enters on GitHub, and how the hub waits for it. */
export interface DeviceCode {
  readonly deviceCode: Redacted.Redacted<string>;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Seconds until the code lapses. */
  readonly expiresIn: number;
  /** The fewest seconds between two polls. */
  readonly interval: number;
}

/** A user access token and what renews it. Times are epoch milliseconds; null when GitHub gave none. */
export interface UserTokens {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken: Redacted.Redacted<string> | null;
  readonly expiresAt: number | null;
  readonly refreshExpiresAt: number | null;
}

export type DevicePoll =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "SlowDown"; readonly interval: number }
  | { readonly _tag: "Granted"; readonly tokens: UserTokens };

export class GitHubSignIn extends Context.Service<
  GitHubSignIn,
  {
    readonly requestDeviceCode: (clientId: string) => Effect.Effect<DeviceCode, GitHubSignInError>;
    readonly pollDeviceCode: (
      clientId: string,
      deviceCode: Redacted.Redacted<string>,
    ) => Effect.Effect<DevicePoll, GitHubSignInError>;
    readonly refresh: (
      clientId: string,
      refreshToken: Redacted.Redacted<string>,
    ) => Effect.Effect<UserTokens, GitHubSignInError>;
    /** The login the token belongs to. */
    readonly login: (token: Redacted.Redacted<string>) => Effect.Effect<string, GitHubSignInError>;
    /** The repositories the token reaches through the app's installations. */
    readonly repositories: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<ReadonlyArray<GitHubReachableRepository>, GitHubSignInError>;
  }
>()("@hobbots/charms/GitHubSignIn") {}

const failed = (message: string) => new GitHubSignInError({ reason: "failed", message });

const DeviceCodeJson = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});
// GitHub answers 200 with an `error` while it waits, and for most refusals.
const TokenJson = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  refresh_token_expires_in: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Number),
});
const UserJson = Schema.Struct({ login: Schema.String });
const InstallationsJson = Schema.Struct({ installations: Schema.Array(Schema.Struct({ id: Schema.Number })) });
const InstallationRepositoriesJson = Schema.Struct({
  repositories: Schema.Array(Schema.Struct({ full_name: Schema.String, private: Schema.Boolean })),
});

const PAGE = 100;
// Enough for any person's installations; GitHub would keep paging past a mistake.
const MAX_PAGES = 50;

/** Every item of a listing GitHub pages, read page by page until a short page. */
const allPages = <A, E>(page: (n: number) => Effect.Effect<ReadonlyArray<A>, E>) =>
  Effect.gen(function* () {
    const items: Array<A> = [];
    for (let n = 1; n <= MAX_PAGES; n++) {
      const next = yield* page(n);
      items.push(...next);
      if (next.length < PAGE) return items;
    }
    // Past the cap the rest is left out, so a repository there is refused, never wrongly reached.
    yield* Effect.logWarning(`GitHub listed more than ${MAX_PAGES * PAGE} items; the rest were not read.`);
    return items;
  });

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Why a device code poll or a refresh answered with an error, in words for the person. */
const tokenError = (error: string): GitHubSignInError => {
  switch (error) {
    case "expired_token":
    case "token_expired":
      return new GitHubSignInError({ reason: "expired", message: "The code lapsed before it was entered. Try again." });
    case "access_denied":
      return new GitHubSignInError({ reason: "denied", message: "GitHub says the sign-in was cancelled." });
    case "bad_refresh_token":
      return new GitHubSignInError({
        reason: "refused",
        message: "GitHub no longer accepts the hub's sign-in. Connect GitHub again in Settings.",
      });
    case "device_flow_disabled":
    case "incorrect_client_credentials":
      return failed("The Hobbots GitHub App on this hub is not set up for signing in from a device.");
    default:
      return failed(`GitHub refused the sign-in (${error}). Try again.`);
  }
};

export interface GitHubHosts {
  /** Where GitHub signs people in. */
  readonly web: string;
  /** GitHub's REST API. */
  readonly api: string;
}

export const GITHUB_HOSTS: GitHubHosts = { web: "https://github.com", api: "https://api.github.com" };

/** GitHub's sign-in over `fetch`. */
export const GitHubSignInLive = (hosts: GitHubHosts = GITHUB_HOSTS) =>
  Layer.effect(
    GitHubSignIn,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      const send = <S extends Schema.Constraint>(
        request: HttpClientRequest.HttpClientRequest,
        schema: S,
        what: string,
      ): Effect.Effect<S["Type"], GitHubSignInError, S["DecodingServices"]> =>
        Effect.gen(function* () {
          const response = yield* http
            .execute(
              request.pipe(
                HttpClientRequest.acceptJson,
                HttpClientRequest.setHeaders({ "User-Agent": "Hobbots", "X-GitHub-Api-Version": "2022-11-28" }),
              ),
            )
            .pipe(
              Effect.timeout("20 seconds"),
              Effect.mapError(() => failed(`GitHub did not answer for ${what}.`)),
            );
          if (response.status === 401) {
            return yield* new GitHubSignInError({
              reason: "refused",
              message: "GitHub no longer accepts the hub's sign-in. Connect GitHub again in Settings.",
            });
          }
          if (response.status < 200 || response.status >= 300) {
            return yield* failed(`GitHub answered ${response.status} for ${what}.`);
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
            Effect.mapError(() => failed(`GitHub's answer for ${what} was not as expected.`)),
          );
        });

      const tokens = (json: typeof TokenJson.Type) =>
        Effect.gen(function* () {
          if (json.access_token === undefined) return yield* tokenError(json.error ?? "no_token");
          const now = yield* Clock.currentTimeMillis;
          return {
            accessToken: Redacted.make(json.access_token),
            refreshToken: json.refresh_token === undefined ? null : Redacted.make(json.refresh_token),
            expiresAt: json.expires_in === undefined ? null : now + json.expires_in * 1000,
            refreshExpiresAt:
              json.refresh_token_expires_in === undefined ? null : now + json.refresh_token_expires_in * 1000,
          } satisfies UserTokens;
        });

      const authorized = (path: string, token: Redacted.Redacted<string>, params: Record<string, string> = {}) =>
        HttpClientRequest.get(`${hosts.api}${path}`, { urlParams: params }).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
        );

      return GitHubSignIn.of({
        requestDeviceCode: (clientId) =>
          send(
            HttpClientRequest.post(`${hosts.web}/login/device/code`).pipe(
              HttpClientRequest.bodyUrlParams({ client_id: clientId }),
            ),
            DeviceCodeJson,
            "a sign-in code",
          ).pipe(
            Effect.map((json) => ({
              deviceCode: Redacted.make(json.device_code),
              userCode: json.user_code,
              verificationUri: json.verification_uri,
              expiresIn: json.expires_in,
              interval: json.interval,
            })),
          ),
        pollDeviceCode: (clientId, deviceCode) =>
          send(
            HttpClientRequest.post(`${hosts.web}/login/oauth/access_token`).pipe(
              HttpClientRequest.bodyUrlParams({
                client_id: clientId,
                device_code: Redacted.value(deviceCode),
                grant_type: DEVICE_GRANT,
              }),
            ),
            TokenJson,
            "the sign-in",
          ).pipe(
            Effect.flatMap((json): Effect.Effect<DevicePoll, GitHubSignInError> => {
              if (json.error === "authorization_pending") return Effect.succeed({ _tag: "Pending" });
              if (json.error === "slow_down") return Effect.succeed({ _tag: "SlowDown", interval: json.interval ?? 0 });
              return Effect.map(tokens(json), (granted) => ({ _tag: "Granted", tokens: granted }));
            }),
          ),
        refresh: (clientId, refreshToken) =>
          send(
            HttpClientRequest.post(`${hosts.web}/login/oauth/access_token`).pipe(
              HttpClientRequest.bodyUrlParams({
                client_id: clientId,
                grant_type: "refresh_token",
                refresh_token: Redacted.value(refreshToken),
              }),
            ),
            TokenJson,
            "a fresh sign-in",
          ).pipe(Effect.flatMap(tokens)),
        login: (token) => send(authorized("/user", token), UserJson, "your account").pipe(Effect.map((u) => u.login)),
        repositories: (token) =>
          Effect.gen(function* () {
            const installations = yield* allPages((page) =>
              send(
                authorized("/user/installations", token, { per_page: String(PAGE), page: String(page) }),
                InstallationsJson,
                "the app's installations",
              ).pipe(Effect.map((json) => json.installations)),
            );
            const lists = yield* Effect.forEach(installations, (installation) =>
              allPages((page) =>
                send(
                  authorized(`/user/installations/${installation.id}/repositories`, token, {
                    per_page: String(PAGE),
                    page: String(page),
                  }),
                  InstallationRepositoriesJson,
                  "the repositories the app reaches",
                ).pipe(Effect.map((json) => json.repositories)),
              ),
            );
            return lists
              .flat()
              .map((repository) => ({ fullName: repository.full_name, private: repository.private }))
              .sort((a, b) => a.fullName.localeCompare(b.fullName));
          }),
      });
    }),
  );

/** The sign-in with the hub's own `fetch`. */
export const GitHubSignInNode = (hosts?: GitHubHosts) =>
  GitHubSignInLive(hosts).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * A stand-in for GitHub's sign-in, for a hub started with `HOBBOTS_FAKE_GITHUB=on`: the code is
 * entered by the second poll, and the account reaches one repository, then a second one from
 * `ADDED_AFTER_MS` after GitHub first listed them, as if the person added it on GitHub. Its tokens
 * reach nothing.
 */
const ADDED_AFTER_MS = 6_000;

export const GitHubSignInFake = Layer.effect(
  GitHubSignIn,
  Effect.sync(() => {
    let polls = 0;
    let firstListed: number | null = null;
    const granted = Effect.map(Clock.currentTimeMillis, (now) => ({
      accessToken: Redacted.make("ghu_fakeHobbotsToken0000000000000000000"),
      refreshToken: Redacted.make("ghr_fakeHobbotsRefresh00000000000000000"),
      expiresAt: now + 8 * 3_600_000,
      refreshExpiresAt: now + 180 * 24 * 3_600_000,
    }));
    return GitHubSignIn.of({
      requestDeviceCode: () =>
        Effect.sync(() => {
          polls = 0;
          return {
            deviceCode: Redacted.make("fake-device-code"),
            userCode: "HOBS-0001",
            verificationUri: "https://github.com/login/device",
            expiresIn: 900,
            interval: 1,
          };
        }),
      pollDeviceCode: () =>
        ++polls < 2
          ? Effect.succeed({ _tag: "Pending" } as const)
          : Effect.map(granted, (tokens) => ({ _tag: "Granted", tokens }) as const),
      refresh: () => granted,
      login: () => Effect.succeed("octohob"),
      repositories: () =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          firstListed ??= now;
          return [
            ...(now - firstListed >= ADDED_AFTER_MS ? [{ fullName: "octohob/notes", private: false }] : []),
            { fullName: "octohob/workshop", private: true },
          ];
        }),
    });
  }),
);
