import { GitHubAccounts } from "@hobbots/agents";
import {
  type AgentId,
  type GitHubAccount,
  type GitHubReachableRepository,
  type GitHubRepository,
  repositorySlug,
} from "@hobbots/domain";
import {
  Cache,
  Clock,
  Context,
  DateTime,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import { GitHubError } from "./github-error.ts";
import { GitHubSignIn, type GitHubSignInError, type UserTokens } from "./github-sign-in.ts";
import { Keychain, type KeychainError } from "./keychain.ts";
import { LocalGitHubSignIns, type LocalSource } from "./local-sign-ins.ts";

/**
 * The GitHub account the user connects on the hub (#322, ADR 020). The Charm asks
 * `GitHubCredential` for a token per call; Settings connects and disconnects through
 * `GitHubConnection`. The tokens live in the OS keychain, read on the hub only; the database keeps
 * who is connected and since when.
 */

/**
 * The Hobbots GitHub App every hub signs in through unless told otherwise. A client ID is public,
 * so it ships in the source; null until the app is registered, which leaves connecting off.
 */
export const HOBBOTS_GITHUB_APP = { clientId: null as string | null, slug: "hobbots" } as const;

/** Which GitHub App the hub signs in through. The client ID is public; the hub holds no secret. */
export interface GitHubAppConfig {
  /** Null when this build names no app, so connecting is not offered. */
  readonly clientId: string | null;
  /** The app's name in its `github.com/apps/<slug>` address, where repositories are picked. */
  readonly slug: string;
  /** A token from the hub's environment (`HOBBOTS_GITHUB_TOKEN`), which replaces the connected account. */
  readonly environmentToken: Redacted.Redacted<string> | null;
}

/** Why the hub is not connected now, after something went wrong. */
export interface GitHubProblem {
  readonly reason: "expired" | "denied" | "refused" | "failed";
  readonly message: string;
}

export type GitHubConnectionState =
  | { readonly _tag: "Environment" }
  | { readonly _tag: "Connected"; readonly account: GitHubAccount }
  | {
      readonly _tag: "Connecting";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: string;
    }
  | {
      readonly _tag: "Disconnected";
      readonly problem: GitHubProblem | null;
      /** Why connecting is not offered on this hub, or null when it is. */
      readonly cannotConnect: "no-app" | "no-keychain" | null;
    };

/** Why connecting did not start. */
export class GitHubConnectRefused extends Schema.TaggedError<GitHubConnectRefused>()("GitHubConnectRefused", {
  /** `environment`: the hub uses HOBBOTS_GITHUB_TOKEN. `not-found`: the chosen sign-in cannot be read. */
  reason: Schema.Literals(["environment", "no-app", "no-keychain", "not-found", "failed"]),
  message: Schema.String,
}) {}

/** The token a Charm call uses, chosen per hob: today always the user's own account (#221 adds a second source). */
export class GitHubCredential extends Context.Service<
  GitHubCredential,
  {
    /** Whether GitHub is connected, so a turn may offer the Charm. Reads no secret. */
    readonly connected: Effect.Effect<boolean>;
    /** A token for the hob's call (null: the hub's own read), refreshed first when it is close to expiry. */
    readonly tokenFor: (agentId: AgentId | null) => Effect.Effect<Redacted.Redacted<string>, GitHubError>;
    /**
     * After GitHub refused `token` (401): a refreshed token to try once more, or `signed-out` once
     * the hub has marked GitHub disconnected.
     */
    readonly refused: (
      agentId: AgentId | null,
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<Redacted.Redacted<string>, GitHubError>;
    /** GitHub refused a refreshed token too: the hub disconnects. */
    readonly revoked: Effect.Effect<void>;
    /**
     * Fails unless the hob's sign-in may act on `repository`. An app token also reads every public
     * repository, so with the app the repository must be one it is installed on (ADR 020), as GitHub
     * listed them within the last minute. The other sign-ins reach every repository they can see.
     */
    readonly reaches: (agentId: AgentId, repository: GitHubRepository) => Effect.Effect<void, GitHubError>;
  }
>()("@hobbots/charms/GitHubCredential") {}

/** Connecting and disconnecting the account from Settings. */
export class GitHubConnection extends Context.Service<
  GitHubConnection,
  {
    readonly state: Effect.Effect<GitHubConnectionState>;
    /** Starts the device flow; the hub waits for the person in the background. */
    readonly connect: Effect.Effect<GitHubConnectionState, GitHubConnectRefused>;
    /** Stops waiting for a code the person has not entered. */
    readonly cancel: Effect.Effect<GitHubConnectionState>;
    /** Deletes the sign-in from the keychain and forgets the account. */
    readonly disconnect: Effect.Effect<GitHubConnectionState>;
    /** The sign-ins already on the hub the user can choose instead, each with its account. */
    readonly found: Effect.Effect<ReadonlyArray<{ readonly source: LocalSource; readonly login: string }>>;
    /** Connects with a sign-in already on the hub, replacing the app's. */
    readonly use: (source: LocalSource) => Effect.Effect<GitHubConnectionState, GitHubConnectRefused>;
    /** The repositories the connected account reaches through the app, or null when it reaches every one it can see. */
    readonly repositories: Effect.Effect<ReadonlyArray<GitHubReachableRepository> | null, GitHubError>;
    /** Where the person installs the app on more repositories. */
    readonly installUrl: string;
  }
>()("@hobbots/charms/GitHubConnection") {}

// The keychain item: both tokens and their expiry, as base64url JSON so the item holds no quotes.
const StoredTokens = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  refreshExpiresAt: Schema.NullOr(Schema.Number),
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredTokens));

const encodeTokens = (tokens: UserTokens): Redacted.Redacted<string> =>
  Redacted.make(
    Buffer.from(
      JSON.stringify({
        accessToken: Redacted.value(tokens.accessToken),
        refreshToken: tokens.refreshToken === null ? null : Redacted.value(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      }),
    ).toString("base64url"),
  );

const decodeTokens = (secret: Redacted.Redacted<string>): UserTokens | null => {
  return Option.match(decodeStored(Buffer.from(Redacted.value(secret), "base64url").toString("utf8")), {
    onNone: () => null,
    onSome: (stored) => ({
      accessToken: Redacted.make(stored.accessToken),
      refreshToken: stored.refreshToken === null ? null : Redacted.make(stored.refreshToken),
      expiresAt: stored.expiresAt,
      refreshExpiresAt: stored.refreshExpiresAt,
    }),
  });
};

/** How each sign-in already on the hub is named to the person. */
const LOCAL_LABEL: Record<LocalSource, string> = {
  gh: "Your GitHub CLI sign-in",
  git: "The credential Git keeps for github.com",
};

/** A token this close to expiry is refreshed before it is used. */
const REFRESH_AHEAD_MS = 5 * 60_000;

const disconnected = new GitHubError({
  reason: "signed-out",
  message: "GitHub is disconnected on this hub. Connect it again in Settings › Charms.",
});

const keychainFailed = (error: KeychainError) => new GitHubError({ reason: "failed", message: error.message });

interface Pending {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly fiber: Fiber.Fiber<void>;
}

/** The connected account, its keychain item and the device flow, as both services. */
export const GitHubAccountLive = (config: GitHubAppConfig) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const keychain = yield* Keychain;
      const signIn = yield* GitHubSignIn;
      const accounts = yield* GitHubAccounts;
      const local = yield* LocalGitHubSignIns;
      const scope = yield* Effect.scope;
      // The tokens as last read from or written to the keychain, so a call does not run the keychain tool each time.
      const cache = yield* Ref.make(Option.none<UserTokens>());
      const pending = yield* Ref.make(Option.none<Pending>());
      const problem = yield* Ref.make<GitHubProblem | null>(null);
      // One refresh at a time: GitHub retires a refresh token as soon as it is used.
      const refreshing = yield* Semaphore.make(1);
      // Saving a sign-in and forgetting one never interleave, and a refresh that started before a
      // forget does not save its pair after it: each forget starts a new generation.
      const committing = yield* Semaphore.make(1);
      const generation = yield* Ref.make(0);
      // One device flow at a time, so a second press cannot start a code nobody can cancel.
      const connecting = yield* Semaphore.make(1);

      /** Forgets the account and deletes its keychain item, keeping why for Settings. */
      const forget = (why: GitHubProblem | null) =>
        Effect.gen(function* () {
          yield* Ref.update(generation, (n) => n + 1);
          yield* Ref.set(cache, Option.none());
          yield* accounts.clear;
          yield* Ref.set(problem, why);
          yield* keychain.remove.pipe(
            Effect.catch((error) =>
              Effect.logWarning("The GitHub sign-in could not be deleted from the keychain", error),
            ),
          );
        }).pipe(committing.withPermits(1), Effect.uninterruptible);

      const stored = Effect.gen(function* () {
        const cached = yield* Ref.get(cache);
        if (Option.isSome(cached)) return cached.value;
        const secret = yield* keychain.read.pipe(Effect.mapError(keychainFailed));
        if (Option.isNone(secret)) {
          if ((yield* accounts.get) === null) return yield* disconnected;
          // A locked keyring answers as if there were no item, so the account is kept: unlocking it
          // brings the sign-in back, and Disconnect still clears it.
          return yield* new GitHubError({
            reason: "signed-out",
            message:
              "The hub's keychain did not give back the GitHub sign-in. Unlock it, or disconnect and connect GitHub again in Settings › Charms.",
          });
        }
        const tokens = decodeTokens(secret.value);
        if (tokens === null) {
          // An item Hobbots cannot read is no sign-in.
          if ((yield* accounts.get) !== null) yield* forget(null);
          return yield* disconnected;
        }
        yield* Ref.set(cache, Option.some(tokens));
        return tokens;
      });

      /** Refreshes `from`, saving the new pair before it is used. Disconnects when GitHub will not. */
      const refresh = (from: UserTokens) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (
            config.clientId === null ||
            from.refreshToken === null ||
            (from.refreshExpiresAt !== null && from.refreshExpiresAt <= now)
          ) {
            yield* forget({
              reason: "expired",
              message: "The hub's GitHub sign-in expired. Connect GitHub again.",
            });
            return yield* disconnected;
          }
          const started = yield* Ref.get(generation);
          const clientId = config.clientId;
          const refreshToken = from.refreshToken;
          // Once GitHub answers, the old pair is dead: a stopped turn must not lose the new one.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const next = yield* signIn
                .refresh(clientId, refreshToken)
                .pipe(
                  Effect.catchTag("GitHubSignInError", (error: GitHubSignInError) =>
                    error.reason === "refused"
                      ? forget({ reason: "refused", message: error.message }).pipe(
                          Effect.andThen(Effect.fail(disconnected)),
                        )
                      : Effect.fail(new GitHubError({ reason: "failed", message: error.message })),
                  ),
                );
              const kept = yield* committing.withPermits(1)(
                Effect.gen(function* () {
                  // Disconnected meanwhile: the pair is dropped, never written back.
                  if ((yield* Ref.get(generation)) !== started) return false;
                  yield* Ref.set(cache, Option.some(next));
                  yield* keychain
                    .write(encodeTokens(next))
                    .pipe(
                      Effect.catch((error) =>
                        Effect.logError("The fresh GitHub sign-in could not be saved to the keychain", error),
                      ),
                    );
                  return true;
                }),
              );
              if (!kept) return yield* disconnected;
              return next;
            }),
          );
        });

      /** The app's token, refreshed first when it is close to expiry. */
      const appToken = Effect.gen(function* () {
        const tokens = yield* stored;
        const now = yield* Clock.currentTimeMillis;
        if (tokens.expiresAt === null || tokens.expiresAt - REFRESH_AHEAD_MS > now) return tokens.accessToken;
        return yield* refreshing.withPermits(1)(
          Effect.gen(function* () {
            // Another call may have refreshed while this one waited.
            const current = yield* stored;
            if (current.expiresAt === null || current.expiresAt - REFRESH_AHEAD_MS > now) {
              return current.accessToken;
            }
            return (yield* refresh(current)).accessToken;
          }),
        );
      });

      /** A sign-in the user keeps elsewhere on the hub, read again for each call. */
      const localToken = (source: LocalSource) =>
        local.token(source).pipe(
          Effect.flatMap(
            Option.match({
              onSome: (token) => Effect.succeed(token),
              onNone: () =>
                Effect.fail(
                  new GitHubError({
                    reason: "signed-out",
                    message: `${LOCAL_LABEL[source]} on this hub cannot be read now. Sign in again, or choose another sign-in in Settings › Charms.`,
                  }),
                ),
            }),
          ),
        );

      // Today every hob uses the user's own account; a hob's own identity (#221) would be chosen here.
      const tokenFor = (_agentId: AgentId | null) =>
        Effect.gen(function* () {
          if (config.environmentToken !== null) return config.environmentToken;
          const account = yield* accounts.get;
          if (account === null) return yield* disconnected;
          return yield* account.source === "app" ? appToken : localToken(account.source);
        });

      const refused = (_agentId: AgentId | null, token: Redacted.Redacted<string>) =>
        config.environmentToken !== null
          ? Effect.fail(
              new GitHubError({
                reason: "signed-out",
                message: "GitHub refused the HOBBOTS_GITHUB_TOKEN the hub was started with.",
              }),
            )
          : Effect.gen(function* () {
              const account = yield* accounts.get;
              if (account === null) return yield* disconnected;
              // The hub cannot renew a sign-in it does not own; the user signs in again where they keep it.
              if (account.source !== "app") {
                return yield* new GitHubError({
                  reason: "signed-out",
                  message: `GitHub refused ${LOCAL_LABEL[account.source]}. Sign in again, or choose another sign-in in Settings › Charms.`,
                });
              }
              return yield* refreshing.withPermits(1)(
                Effect.gen(function* () {
                  const current = yield* stored;
                  if (Redacted.value(current.accessToken) !== Redacted.value(token)) return current.accessToken;
                  return (yield* refresh(current)).accessToken;
                }),
              );
            });

      const revoked =
        config.environmentToken !== null
          ? Effect.void
          : forget({ reason: "refused", message: "GitHub no longer accepts the hub's sign-in. Connect GitHub again." });

      const cannotConnect = Effect.gen(function* () {
        if (config.clientId === null) return "no-app" as const;
        const usable = yield* keychain.read.pipe(
          Effect.as(true),
          Effect.catch((error) => Effect.succeed(error.reason !== "unavailable")),
        );
        return usable ? null : ("no-keychain" as const);
      });

      const state = Effect.gen(function* (): Effect.fn.Return<GitHubConnectionState> {
        if (config.environmentToken !== null) return { _tag: "Environment" };
        const waiting = yield* Ref.get(pending);
        if (Option.isSome(waiting)) {
          const { userCode, verificationUri, expiresAt } = waiting.value;
          return {
            _tag: "Connecting",
            userCode,
            verificationUri,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          };
        }
        const account = yield* accounts.get;
        if (account !== null) return { _tag: "Connected", account };
        return { _tag: "Disconnected", problem: yield* Ref.get(problem), cannotConnect: yield* cannotConnect };
      });

      /** Polls GitHub no faster than it asks, until the person enters the code, says no, or it lapses. */
      const waitFor = (
        clientId: string,
        code: { deviceCode: Redacted.Redacted<string>; interval: number },
        expiresAt: number,
      ) =>
        Effect.gen(function* () {
          let interval = Math.max(code.interval, 1);
          // A loop, not Effect.repeat with a Schedule: GitHub's slow_down answer changes the delay mid-way.
          while (true) {
            yield* Effect.sleep(`${interval} seconds`);
            if ((yield* Clock.currentTimeMillis) >= expiresAt) {
              return yield* Effect.fail<GitHubProblem>({
                reason: "expired",
                message: "The code lapsed before it was entered. Try again.",
              });
            }
            const answer = yield* signIn
              .pollDeviceCode(clientId, code.deviceCode)
              .pipe(Effect.mapError((error): GitHubProblem => ({ reason: error.reason, message: error.message })));
            if (answer._tag === "Pending") continue;
            // GitHub adds 5 seconds and says the new interval; take the longer of the two.
            if (answer._tag === "SlowDown") {
              interval = Math.max(answer.interval, interval + 5);
              continue;
            }
            const login = yield* signIn
              .login(answer.tokens.accessToken)
              .pipe(Effect.mapError((error): GitHubProblem => ({ reason: "failed", message: error.message })));
            // The item and the account row are saved together, so Cancel cannot leave one without the other.
            yield* Effect.gen(function* () {
              yield* keychain
                .write(encodeTokens(answer.tokens))
                .pipe(Effect.mapError((error): GitHubProblem => ({ reason: "failed", message: error.message })));
              yield* Ref.set(cache, Option.some(answer.tokens));
              const connectedAt = DateTime.formatIso(yield* DateTime.now);
              yield* accounts.save({ source: "app", login, connectedAt });
              yield* Ref.set(problem, null);
            }).pipe(committing.withPermits(1), Effect.uninterruptible);
            yield* Effect.logInfo("GitHub connected", { login });
            return;
          }
        }).pipe(
          Effect.catch((why) => Ref.set(problem, why)),
          Effect.ensuring(Ref.set(pending, Option.none())),
        );

      const stopWaiting = Effect.gen(function* () {
        const waiting = yield* Ref.getAndSet(pending, Option.none());
        if (Option.isSome(waiting)) yield* Fiber.interrupt(waiting.value.fiber);
      });

      const connect = Effect.gen(function* () {
        if (config.environmentToken !== null) {
          return yield* new GitHubConnectRefused({
            reason: "environment",
            message: "This hub reaches GitHub with the HOBBOTS_GITHUB_TOKEN it was started with.",
          });
        }
        const clientId = config.clientId;
        if (clientId === null) {
          return yield* new GitHubConnectRefused({
            reason: "no-app",
            message: "This build of Hobbots names no GitHub App. Start the hub with HOBBOTS_GITHUB_CLIENT_ID.",
          });
        }
        if ((yield* cannotConnect) === "no-keychain") {
          return yield* new GitHubConnectRefused({
            reason: "no-keychain",
            message: "This hub has no keychain Hobbots can use, so it does not keep a GitHub sign-in.",
          });
        }
        // A second press while a code is showing keeps that code.
        if (Option.isSome(yield* Ref.get(pending))) return yield* state;
        const code = yield* signIn
          .requestDeviceCode(clientId)
          .pipe(Effect.mapError((error) => new GitHubConnectRefused({ reason: "failed", message: error.message })));
        const expiresAt = (yield* Clock.currentTimeMillis) + code.expiresIn * 1000;
        yield* Ref.set(problem, null);
        const fiber = yield* Effect.forkIn(waitFor(clientId, code, expiresAt), scope, { startImmediately: false });
        yield* Ref.set(
          pending,
          Option.some({ userCode: code.userCode, verificationUri: code.verificationUri, expiresAt, fiber }),
        );
        return yield* state;
      }).pipe(connecting.withPermits(1));

      /** The sign-ins already on the hub, with the account each belongs to; one GitHub refuses is left out. */
      const found = Effect.forEach(
        ["gh", "git"] as const,
        (source) =>
          local.token(source).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed([]),
                onSome: (token) =>
                  signIn.login(token).pipe(
                    Effect.map((login) => [{ source, login }]),
                    Effect.catch(() => Effect.succeed([])),
                  ),
              }),
            ),
          ),
        { concurrency: 2 },
      ).pipe(Effect.map((lists) => lists.flat()));

      const use = (source: LocalSource) =>
        Effect.gen(function* () {
          if (config.environmentToken !== null) {
            return yield* new GitHubConnectRefused({
              reason: "environment",
              message: "This hub reaches GitHub with the HOBBOTS_GITHUB_TOKEN it was started with.",
            });
          }
          const missing = new GitHubConnectRefused({
            reason: "not-found",
            message: `${LOCAL_LABEL[source]} on this hub cannot be read now. Sign in again, then try once more.`,
          });
          const token = yield* local.token(source).pipe(
            Effect.flatMap(Effect.fromOption),
            Effect.mapError(() => missing),
          );
          const login = yield* signIn
            .login(token)
            .pipe(Effect.mapError((error) => new GitHubConnectRefused({ reason: "failed", message: error.message })));
          yield* stopWaiting;
          // The app's sign-in, if there was one, is not kept beside the one chosen now.
          yield* forget(null);
          yield* accounts.save({ source, login, connectedAt: DateTime.formatIso(yield* DateTime.now) });
          yield* Effect.logInfo("GitHub connected", { source, login });
          return yield* state;
        });

      const installUrl = `https://github.com/apps/${config.slug}/installations/new`;

      /** The repositories the app is installed on, as GitHub lists them for the connected account. */
      // A refusal is tried once more with a refreshed sign-in; only a second one disconnects.
      const appRepositories = Effect.gen(function* () {
        const list = (
          token: Redacted.Redacted<string>,
          onRefused: Effect.Effect<ReadonlyArray<GitHubReachableRepository>, GitHubError>,
        ): Effect.Effect<ReadonlyArray<GitHubReachableRepository>, GitHubError> =>
          signIn
            .repositories(token)
            .pipe(
              Effect.catchTag("GitHubSignInError", (error: GitHubSignInError) =>
                error.reason === "refused"
                  ? onRefused
                  : Effect.fail(new GitHubError({ reason: "failed", message: error.message })),
              ),
            );
        const token = yield* tokenFor(null);
        return yield* list(
          token,
          refused(null, token).pipe(
            Effect.flatMap((fresh) => list(fresh, revoked.pipe(Effect.andThen(Effect.fail(disconnected))))),
          ),
        );
      });
      // Read again at most a minute later, so uninstalling the app closes a repository within a minute.
      const installed = yield* Cache.make({
        capacity: 1,
        timeToLive: "1 minute",
        lookup: (_login: string) => appRepositories,
      });

      const reaches = (_agentId: AgentId, repository: GitHubRepository) =>
        Effect.gen(function* () {
          if (config.environmentToken !== null) return;
          const account = yield* accounts.get;
          if (account === null) return yield* disconnected;
          if (account.source !== "app") return;
          const slug = repositorySlug(repository);
          // A failed listing is not kept, so the next call asks GitHub again.
          const listed = yield* Cache.get(installed, account.login).pipe(
            Effect.tapError(() => Cache.invalidate(installed, account.login)),
          );
          if (!listed.some((reached) => reached.fullName.toLowerCase() === slug.toLowerCase())) {
            return yield* new GitHubError({
              reason: "not-found",
              message: `The Hobbots app is not installed on ${slug}, so GitHub cannot be used there. Install it on that repository at ${installUrl}, then try again.`,
            });
          }
        });

      const credential = GitHubCredential.of({
        connected:
          config.environmentToken !== null ? Effect.succeed(true) : Effect.map(accounts.get, (a) => a !== null),
        tokenFor,
        refused,
        revoked,
        reaches,
      });

      const connection = GitHubConnection.of({
        state,
        connect,
        cancel: stopWaiting.pipe(Effect.andThen(state)),
        disconnect: stopWaiting.pipe(Effect.andThen(forget(null)), Effect.andThen(state)),
        found,
        use,
        repositories: Effect.gen(function* () {
          // A sign-in other than the app's reaches every repository it can see.
          const account = yield* accounts.get;
          if (account?.source !== "app" || config.environmentToken !== null) return null;
          // What Settings shows is what the Charm checks against.
          yield* Cache.invalidate(installed, account.login);
          return yield* Cache.get(installed, account.login).pipe(
            Effect.tapError(() => Cache.invalidate(installed, account.login)),
          );
        }),
        installUrl,
      });

      return Context.make(GitHubCredential, credential).pipe(Context.add(GitHubConnection, connection));
    }),
  );
