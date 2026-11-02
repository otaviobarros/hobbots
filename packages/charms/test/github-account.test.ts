import { GitHubAccounts } from "@hobbots/agents";
import { AgentId, type GitHubAccount } from "@hobbots/domain";
import { Clock, Effect, Fiber, Layer, Option, Redacted, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  type DevicePoll,
  GitHubAccountLive,
  type GitHubAppConfig,
  GitHubConnection,
  GitHubCredential,
  GitHubSignIn,
  GitHubSignInError,
  Keychain,
  KeychainError,
  KeychainMemory,
  LocalGitHubSignIns,
  type LocalSource,
  type UserTokens,
} from "../src/index.ts";

const HOB = AgentId.make("hob");
const APP: GitHubAppConfig = { clientId: "Iv23liHobbots", slug: "hobbots", environmentToken: null };
const HOUR = 3_600_000;

interface Script {
  /** What each poll answers, in order; the last one repeats. */
  readonly polls: Array<DevicePoll | GitHubSignInError>;
  /** What each refresh answers, in order. */
  readonly refreshes: Array<UserTokens | GitHubSignInError>;
  /** Everything the hub asked GitHub, with the time it asked, in seconds since the start. */
  readonly asked: Array<string>;
  /** The repositories the app is installed on, as GitHub lists them now. */
  installed?: Array<string>;
  /** Access tokens GitHub refuses when listing installations. */
  refuseListing?: Array<string>;
  /** Seconds GitHub takes to answer a refresh. */
  refreshDelay?: number;
}

const tokens = (access: string, expiresAt: number | null = 8 * HOUR, refresh: string | null = `ghr_${access}`) => ({
  accessToken: Redacted.make(access),
  refreshToken: refresh === null ? null : Redacted.make(refresh),
  expiresAt,
  refreshExpiresAt: 180 * 24 * HOUR,
});

const fakeSignIn = (script: Script) =>
  Layer.succeed(
    GitHubSignIn,
    GitHubSignIn.of({
      requestDeviceCode: (clientId) =>
        Effect.sync(() => {
          script.asked.push(`code for ${clientId}`);
          return {
            deviceCode: Redacted.make("device-code"),
            userCode: "WDJB-MJHT",
            verificationUri: "https://github.com/login/device",
            expiresIn: 900,
            interval: 5,
          };
        }),
      pollDeviceCode: () =>
        Effect.gen(function* () {
          const at = (yield* Clock.currentTimeMillis) / 1000;
          script.asked.push(`poll at ${at}`);
          const answer = script.polls.length > 1 ? script.polls.shift() : script.polls[0];
          if (answer === undefined) return { _tag: "Pending" as const };
          return answer instanceof GitHubSignInError ? yield* answer : answer;
        }),
      refresh: (_clientId, refreshToken) =>
        Effect.gen(function* () {
          script.asked.push(`refresh ${Redacted.value(refreshToken)}`);
          if (script.refreshDelay !== undefined) yield* Effect.sleep(`${script.refreshDelay} seconds`);
          const answer = script.refreshes.shift();
          if (answer === undefined) throw new Error("No refresh was expected");
          return answer instanceof GitHubSignInError ? yield* answer : answer;
        }),
      login: (token) => Effect.succeed(Redacted.value(token).startsWith("gho_") ? "from-gh" : "otaviobarros"),
      repositories: (token) =>
        Effect.gen(function* () {
          script.asked.push(`installations with ${Redacted.value(token)}`);
          if (script.refuseListing?.includes(Redacted.value(token))) {
            return yield* new GitHubSignInError({ reason: "refused", message: "Bad credentials" });
          }
          return (script.installed ?? ["otaviobarros/hobbots"]).map((fullName) => ({ fullName, private: false }));
        }),
    }),
  );

/** The account table, in memory. */
const fakeAccounts = (row: Ref.Ref<GitHubAccount | null>) =>
  Layer.succeed(
    GitHubAccounts,
    GitHubAccounts.of({ get: Ref.get(row), save: (account) => Ref.set(row, account), clear: Ref.set(row, null) }),
  );

const setup = (
  script: Script,
  options: {
    readonly config?: GitHubAppConfig;
    readonly keychain?: Layer.Layer<Keychain>;
    readonly local?: Partial<Record<LocalSource, string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const row = yield* Ref.make<GitHubAccount | null>(null);
    const layer = GitHubAccountLive(options.config ?? APP).pipe(
      Layer.provide(
        Layer.mergeAll(
          options.keychain ?? KeychainMemory,
          fakeSignIn(script),
          fakeAccounts(row),
          // The sign-ins on the hub, read again each time, as `local` holds them then.
          Layer.succeed(
            LocalGitHubSignIns,
            LocalGitHubSignIns.of({
              token: (source) =>
                Effect.sync(() => Option.map(Option.fromNullishOr(options.local?.[source]), Redacted.make)),
            }),
          ),
        ),
      ),
      Layer.provideMerge(options.keychain ?? KeychainMemory),
    );
    return { row, layer };
  });

/** Lets the hub's waiting fiber run for `seconds` of test time. */
const wait = (seconds: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < seconds; i++) {
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
    }
  });

const run = <A, E>(effect: Effect.Effect<A, E, TestClock.TestClock>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.fresh(TestClock.layer()))));

describe("Connecting GitHub", () => {
  it("[TC-GEN-018] signs in with the device flow, polling no faster than GitHub asks, and keeps the tokens in the keychain", async () => {
    const script: Script = {
      polls: [
        { _tag: "Pending" },
        { _tag: "SlowDown", interval: 10 },
        { _tag: "Pending" },
        { _tag: "Granted", tokens: tokens("ghu_first") },
      ],
      refreshes: [],
      asked: [],
    };
    const result = await run(
      Effect.gen(function* () {
        const { row, layer } = yield* setup(script);
        return yield* Effect.gen(function* () {
          const connection = yield* GitHubConnection;
          const before = yield* connection.state;
          const started = yield* connection.connect;
          // A second press keeps the code on screen.
          const again = yield* connection.connect;
          yield* wait(40);
          const item = yield* (yield* Keychain).read;
          return { before, started, again, after: yield* connection.state, row: yield* Ref.get(row), item };
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
    expect(result.before).toEqual({ _tag: "Disconnected", problem: null, cannotConnect: null });
    expect(result.started).toMatchObject({
      _tag: "Connecting",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresAt: "1970-01-01T00:15:00.000Z",
    });
    expect(result.again).toEqual(result.started);
    // Every 5 seconds, then 10 after GitHub asked to slow down.
    expect(script.asked).toEqual(["code for Iv23liHobbots", "poll at 5", "poll at 10", "poll at 20", "poll at 30"]);
    expect(result.after).toEqual({
      _tag: "Connected",
      account: { source: "app", login: "otaviobarros", connectedAt: "1970-01-01T00:00:30.000Z" },
    });
    expect(result.row).toEqual({ source: "app", login: "otaviobarros", connectedAt: "1970-01-01T00:00:30.000Z" });
    // The keychain item holds both tokens, in a form with no quotes or spaces.
    const item = Option.getOrThrow(result.item);
    expect(Redacted.value(item)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(Redacted.value(item), "base64url").toString("utf8")).toContain("ghr_ghu_first");
  });

  it("[TC-GEN-019] says why it did not connect: the code lapsed, the person said no, or they cancelled", async () => {
    const lapsed: Script = { polls: [{ _tag: "Pending" }], refreshes: [], asked: [] };
    const denied: Script = {
      polls: [new GitHubSignInError({ reason: "denied", message: "GitHub says the sign-in was cancelled." })],
      refreshes: [],
      asked: [],
    };
    const cancelled: Script = { polls: [{ _tag: "Pending" }], refreshes: [], asked: [] };
    const states = await run(
      Effect.gen(function* () {
        const outcome = (script: Script, act: Effect.Effect<unknown, never, GitHubConnection | TestClock.TestClock>) =>
          Effect.gen(function* () {
            const { layer } = yield* setup(script);
            return yield* Effect.gen(function* () {
              const connection = yield* GitHubConnection;
              yield* connection.connect;
              yield* act;
              return yield* connection.state;
            }).pipe(Effect.provide(layer), Effect.scoped);
          });
        return [
          yield* outcome(lapsed, wait(905)),
          yield* outcome(denied, wait(5)),
          yield* outcome(
            cancelled,
            Effect.flatMap(GitHubConnection, (c) => c.cancel),
          ),
        ];
      }),
    );
    expect(states).toEqual([
      {
        _tag: "Disconnected",
        problem: { reason: "expired", message: "The code lapsed before it was entered. Try again." },
        cannotConnect: null,
      },
      {
        _tag: "Disconnected",
        problem: { reason: "denied", message: "GitHub says the sign-in was cancelled." },
        cannotConnect: null,
      },
      { _tag: "Disconnected", problem: null, cannotConnect: null },
    ]);
    expect(cancelled.asked).toEqual(["code for Iv23liHobbots"]);
  });

  it("[TC-GEN-020] refuses to connect without an app or a keychain, and an environment token replaces the account", async () => {
    const noKeychain = Layer.succeed(
      Keychain,
      Keychain.of({
        read: Effect.fail(new KeychainError({ reason: "unavailable", message: "No keychain." })),
        write: () => Effect.fail(new KeychainError({ reason: "unavailable", message: "No keychain." })),
        remove: Effect.void,
      }),
    );
    const script: Script = { polls: [], refreshes: [], asked: [] };
    const results = await run(
      Effect.gen(function* () {
        const attempt = (options: Parameters<typeof setup>[1]) =>
          Effect.gen(function* () {
            const { layer } = yield* setup(script, options);
            return yield* Effect.gen(function* () {
              const connection = yield* GitHubConnection;
              const credential = yield* GitHubCredential;
              return {
                state: yield* connection.state,
                connect: yield* Effect.result(connection.connect),
                connected: yield* credential.connected,
                token: yield* Effect.result(Effect.map(credential.tokenFor(HOB), Redacted.value)),
              };
            }).pipe(Effect.provide(layer), Effect.scoped);
          });
        return [
          yield* attempt({ config: { ...APP, clientId: null } }),
          yield* attempt({ keychain: noKeychain }),
          yield* attempt({ config: { ...APP, environmentToken: Redacted.make("github_pat_env") } }),
        ];
      }),
    );
    expect(results[0]).toMatchObject({
      state: { _tag: "Disconnected", cannotConnect: "no-app" },
      connect: { _tag: "Failure", failure: { _tag: "GitHubConnectRefused" } },
      connected: false,
      token: { _tag: "Failure", failure: { reason: "signed-out" } },
    });
    expect(results[1]).toMatchObject({
      state: { _tag: "Disconnected", cannotConnect: "no-keychain" },
      connect: { _tag: "Failure", failure: { _tag: "GitHubConnectRefused" } },
    });
    expect(results[2]).toMatchObject({
      state: { _tag: "Environment" },
      connect: { _tag: "Failure" },
      connected: true,
      token: { _tag: "Success", success: "github_pat_env" },
    });
    expect(script.asked).toEqual([]);
  });
});

describe("A sign-in already on the hub", () => {
  it("[TC-GEN-021] is offered with its account, read again for each call, and replaces the app's sign-in", async () => {
    const local: Partial<Record<LocalSource, string>> = { gh: "gho_fromTheCli000000000000000" };
    const script: Script = { polls: [{ _tag: "Granted", tokens: tokens("ghu_first") }], refreshes: [], asked: [] };
    const result = await run(
      Effect.gen(function* () {
        const { row, layer } = yield* setup(script, { local });
        return yield* Effect.gen(function* () {
          const connection = yield* GitHubConnection;
          const credential = yield* GitHubCredential;
          yield* connection.connect;
          yield* wait(5);
          const found = yield* connection.found;
          const notThere = yield* Effect.result(connection.use("git"));
          const used = yield* connection.use("gh");
          const item = yield* (yield* Keychain).read;
          const first = Redacted.value(yield* credential.tokenFor(HOB));
          local.gh = "gho_afterSigningInAgain00000000";
          const second = Redacted.value(yield* credential.tokenFor(HOB));
          // GitHub refuses it: the hub cannot renew it, so the call fails, and the choice stays.
          const refused = yield* Effect.result(credential.refused(HOB, Redacted.make(second)));
          delete local.gh;
          const signedOut = yield* Effect.result(credential.tokenFor(HOB));
          return {
            found,
            notThere,
            used,
            item,
            first,
            second,
            refused,
            signedOut,
            row: yield* Ref.get(row),
            repositories: yield* connection.repositories,
          };
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
    expect(result.found).toEqual([{ source: "gh", login: "from-gh" }]);
    expect(result.notThere).toMatchObject({ _tag: "Failure", failure: { _tag: "GitHubConnectRefused" } });
    expect(result.used).toEqual({
      _tag: "Connected",
      account: { source: "gh", login: "from-gh", connectedAt: "1970-01-01T00:00:05.000Z" },
    });
    expect(Option.isNone(result.item)).toBe(true);
    expect([result.first, result.second]).toEqual(["gho_fromTheCli000000000000000", "gho_afterSigningInAgain00000000"]);
    expect(result.refused).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(result.signedOut).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(result.row).toMatchObject({ source: "gh" });
    expect(result.repositories).toBeNull();
    expect(script.asked.filter((asked) => asked.startsWith("refresh"))).toEqual([]);
  });
});

describe("The connected account's token", () => {
  /** Connects with `first`, then runs `use` with the credential and the keychain. */
  const connected = <A, E>(
    script: Script,
    first: UserTokens,
    use: (
      credential: GitHubCredential["Service"],
      keychain: Keychain["Service"],
      connection: GitHubConnection["Service"],
    ) => Effect.Effect<A, E, TestClock.TestClock>,
  ) =>
    run(
      Effect.gen(function* () {
        script.polls.push({ _tag: "Granted", tokens: first });
        const { row, layer } = yield* setup(script);
        return yield* Effect.gen(function* () {
          yield* (yield* GitHubConnection).connect;
          yield* wait(5);
          const value = yield* use(yield* GitHubCredential, yield* Keychain, yield* GitHubConnection);
          return { value, row: yield* Ref.get(row), state: yield* (yield* GitHubConnection).state };
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );

  it("[TC-PE-142] is refreshed once before it expires, and the new pair is kept before it is used", async () => {
    const script: Script = { polls: [], refreshes: [tokens("ghu_second", 20 * HOUR)], asked: [] };
    const result = await connected(script, tokens("ghu_first", 2 * HOUR), (credential, keychain) =>
      Effect.gen(function* () {
        const early = Redacted.value(yield* credential.tokenFor(HOB));
        // Five minutes before it expires, the token is refreshed; two calls at once refresh it once.
        yield* TestClock.setTime(2 * HOUR - 4 * 60_000);
        const both = yield* Effect.all([credential.tokenFor(HOB), credential.tokenFor(HOB)], { concurrency: 2 });
        const item = Option.getOrThrow(yield* keychain.read);
        return {
          early,
          both: both.map(Redacted.value),
          stored: Buffer.from(Redacted.value(item), "base64url").toString("utf8"),
        };
      }),
    );
    expect(result.value.early).toBe("ghu_first");
    expect(result.value.both).toEqual(["ghu_second", "ghu_second"]);
    expect(result.value.stored).toContain("ghr_ghu_second");
    expect(script.asked.filter((asked) => asked.startsWith("refresh"))).toEqual(["refresh ghr_ghu_first"]);
    expect(result.state).toMatchObject({ _tag: "Connected" });
  });

  it("[TC-PE-143] disconnects when GitHub will not refresh it: the keychain item and the account go", async () => {
    const script: Script = {
      polls: [],
      refreshes: [new GitHubSignInError({ reason: "refused", message: "GitHub no longer accepts the hub's sign-in." })],
      asked: [],
    };
    const result = await connected(script, tokens("ghu_first"), (credential, keychain) =>
      Effect.gen(function* () {
        // GitHub refused the token: the hub refreshes once, and GitHub refuses that too.
        const refused = yield* Effect.result(credential.refused(HOB, Redacted.make("ghu_first")));
        return {
          refused,
          connected: yield* credential.connected,
          item: yield* keychain.read,
          next: yield* Effect.result(credential.tokenFor(HOB)),
        };
      }),
    );
    expect(result.value.refused).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(result.value.connected).toBe(false);
    expect(Option.isNone(result.value.item)).toBe(true);
    expect(result.value.next).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(result.row).toBeNull();
    expect(result.state).toMatchObject({
      _tag: "Disconnected",
      problem: { reason: "refused", message: "GitHub no longer accepts the hub's sign-in." },
    });
  });

  it("[TC-GEN-023] reaches only repositories the app is installed on, as GitHub listed them within a minute", async () => {
    const script: Script = { polls: [], refreshes: [], asked: [], installed: ["otaviobarros/hobbots"] };
    const result = await connected(script, tokens("ghu_first"), (credential) =>
      Effect.gen(function* () {
        const reach = (owner: string, name: string) =>
          Effect.result(credential.reaches(HOB, { owner, name })).pipe(Effect.map((r) => r._tag));
        const installed = yield* reach("OtavioBarros", "Hobbots");
        // Public, but the app is not installed there.
        const elsewhere = yield* reach("torvalds", "linux");
        // Uninstalled on GitHub: still reached until the list is a minute old.
        script.installed = [];
        const soon = yield* reach("otaviobarros", "hobbots");
        yield* TestClock.adjust("61 seconds");
        const later = yield* reach("otaviobarros", "hobbots");
        return { installed, elsewhere, soon, later };
      }),
    );
    expect(result.value).toEqual({ installed: "Success", elsewhere: "Failure", soon: "Success", later: "Failure" });
    expect(script.asked.filter((asked) => asked.startsWith("installations"))).toHaveLength(2);
  });

  it("is forgotten on disconnect", async () => {
    const script: Script = { polls: [], refreshes: [], asked: [] };
    const result = await connected(script, tokens("ghu_first"), (credential, keychain, connection) =>
      Effect.gen(function* () {
        const state = yield* connection.disconnect;
        return { state, connected: yield* credential.connected, item: yield* keychain.read };
      }),
    );
    expect(result.value.state).toEqual({ _tag: "Disconnected", problem: null, cannotConnect: null });
    expect(result.value.connected).toBe(false);
    expect(Option.isNone(result.value.item)).toBe(true);
    expect(result.row).toBeNull();
  });
  it("refreshes once more before a refused listing of installations disconnects", async () => {
    const script: Script = {
      polls: [],
      refreshes: [tokens("ghu_second"), tokens("ghu_third")],
      asked: [],
      refuseListing: ["ghu_first"],
    };
    const result = await connected(script, tokens("ghu_first"), (credential) =>
      Effect.gen(function* () {
        const once = (yield* Effect.result(credential.reaches(HOB, { owner: "otaviobarros", name: "hobbots" })))._tag;
        const still = yield* credential.connected;
        // Now GitHub refuses the fresh token too: that is a disconnect.
        script.refuseListing = ["ghu_second", "ghu_third"];
        yield* TestClock.adjust("61 seconds");
        const twice = yield* Effect.result(credential.reaches(HOB, { owner: "otaviobarros", name: "hobbots" }));
        return { once, still, twice, after: yield* credential.connected };
      }),
    );
    expect(result.value.once).toBe("Success");
    expect(result.value.still).toBe(true);
    expect(result.value.twice).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(result.value.after).toBe(false);
    expect(script.asked.filter((asked) => asked.startsWith("refresh"))).toEqual([
      "refresh ghr_ghu_first",
      "refresh ghr_ghu_second",
    ]);
  });

  it("keeps a refreshed pair when the call is stopped, and never writes one back after a disconnect", async () => {
    const script: Script = {
      polls: [],
      refreshes: [tokens("ghu_second", 2 * HOUR), tokens("ghu_third")],
      asked: [],
      refreshDelay: 3,
    };
    const result = await connected(script, tokens("ghu_first", 2 * HOUR), (credential, keychain, connection) =>
      Effect.gen(function* () {
        const holds = Effect.map(keychain.read, (item) =>
          Option.match(item, {
            onNone: () => "nothing",
            onSome: (secret) => Buffer.from(Redacted.value(secret), "base64url").toString("utf8"),
          }),
        );
        // A call is stopped while GitHub answers the refresh.
        yield* TestClock.setTime(2 * HOUR - 60_000);
        const call = yield* Effect.forkChild(credential.tokenFor(HOB));
        yield* wait(1);
        const stopping = yield* Effect.forkChild(Fiber.interrupt(call));
        yield* wait(4);
        yield* Fiber.join(stopping);
        const kept = yield* holds;
        // Disconnecting while a refresh is in flight: the fresh pair is dropped.
        yield* TestClock.setTime(4 * HOUR);
        const second = yield* Effect.forkChild(Effect.result(credential.tokenFor(HOB)));
        yield* wait(1);
        yield* connection.disconnect;
        yield* wait(4);
        return { kept, refreshed: yield* Fiber.join(second), after: yield* holds };
      }),
    );
    expect(result.value.kept).toContain("ghr_ghu_second");
    expect(result.value.refreshed).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(result.value.after).toBe("nothing");
    expect(result.row).toBeNull();
  });
});

describe("Edge cases of the hub's sign-in", () => {
  it("keeps the account when the keychain gives nothing back, since a locked keyring looks the same as a missing item", async () => {
    const script: Script = { polls: [], refreshes: [], asked: [] };
    const result = await run(
      Effect.gen(function* () {
        const { row, layer } = yield* setup(script);
        yield* Ref.set(row, { source: "app" as const, login: "otaviobarros", connectedAt: "2026-11-01T00:00:00.000Z" });
        return yield* Effect.gen(function* () {
          const credential = yield* GitHubCredential;
          const token = yield* Effect.result(credential.tokenFor(HOB));
          return { token, connected: yield* credential.connected, row: yield* Ref.get(row) };
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
    expect(result.token).toMatchObject({ _tag: "Failure", failure: { reason: "signed-out" } });
    expect(result.connected).toBe(true);
    expect(result.row).not.toBeNull();
  });

  it("starts one device flow when Connect is pressed twice at once", async () => {
    const script: Script = { polls: [{ _tag: "Pending" }], refreshes: [], asked: [] };
    await run(
      Effect.gen(function* () {
        const { layer } = yield* setup(script);
        yield* Effect.gen(function* () {
          const connection = yield* GitHubConnection;
          yield* Effect.all([connection.connect, connection.connect], { concurrency: 2 });
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
    );
    expect(script.asked.filter((asked) => asked.startsWith("code for"))).toHaveLength(1);
  });
});
