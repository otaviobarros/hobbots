import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubAccounts, HobbotsRepository, HobGitHubApps } from "@hobbots/agents";
import {
  HobAppKeys,
  HobAppKeysMemory,
  Keychain,
  KeychainError,
  KeychainMemory,
  LegacyKeychain,
  LegacyKeychainMemory,
} from "@hobbots/charms";
import { AgentId, type GitHubSource } from "@hobbots/domain";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { claimLegacySignIns } from "../src/legacy-keychain.ts";
import { forgetKeychain } from "../src/resets.ts";

// Moving a hub's sign-ins out of the keychain items every hub on the computer shared (#1214).

const folder = mkdtempSync(join(tmpdir(), "hobbots-legacy-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
let locks = 0;
/** A lock of the tests' own, so they never wait on a hub running on this computer. */
const newLock = () => join(folder, `lock-${locks++}`);

const FRODO = AgentId.make("frodo");
const SAM = AgentId.make("sam");

/** The hub's records: its hobs, which of them have an app, and which sign-in GitHub uses. */
const records = (withApp: ReadonlyArray<AgentId>, source: GitHubSource | null) =>
  Layer.mergeAll(
    Layer.succeed(HobbotsRepository, {
      listAgentsWithStatus: () => Effect.succeed([FRODO, SAM].map((id) => ({ id, name: id }))),
    } as unknown as HobbotsRepository["Service"]),
    Layer.succeed(HobGitHubApps, {
      get: (id: AgentId) => Effect.succeed(withApp.includes(id) ? ({ slug: `${id}-app` } as never) : null),
      leftOver: () => Effect.succeed(null),
    } as unknown as HobGitHubApps["Service"]),
    Layer.succeed(GitHubAccounts, {
      get: Effect.succeed(source === null ? null : ({ source, login: "otaviobarros" } as never)),
    } as unknown as GitHubAccounts["Service"]),
  );

const value = Option.map(Redacted.value);

/** Runs `seed`, the move, then answers what the hub's own items and the shared ones hold. */
const claim = (
  layer: Layer.Layer<HobbotsRepository | HobGitHubApps | GitHubAccounts>,
  seed: Effect.Effect<void, KeychainError, Keychain | HobAppKeys | LegacyKeychain>,
) =>
  Effect.gen(function* () {
    yield* seed;
    const problems = yield* claimLegacySignIns(newLock());
    const own = yield* Keychain;
    const keys = yield* HobAppKeys;
    const legacy = yield* LegacyKeychain;
    return {
      problems,
      signIn: value(yield* own.read),
      frodoKey: value(yield* keys.read(FRODO)),
      samKey: value(yield* keys.read(SAM)),
      shared: {
        signIn: value(yield* legacy.signIn.read),
        frodoKey: value(yield* legacy.hobAppKeys.read(FRODO)),
        samKey: value(yield* legacy.hobAppKeys.read(SAM)),
      },
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(KeychainMemory, HobAppKeysMemory, LegacyKeychainMemory, layer)),
    Effect.runPromise,
  );

/** The shared items an earlier hub wrote: the GitHub sign-in and both hobs' keys. */
const sharedItems = Effect.gen(function* () {
  const legacy = yield* LegacyKeychain;
  yield* legacy.signIn.write(Redacted.make("dG9rZW5z"));
  yield* legacy.hobAppKeys.write(FRODO, Redacted.make("frodo's key"));
  yield* legacy.hobAppKeys.write(SAM, Redacted.make("sam's key"));
});

describe("Moving sign-ins out of the shared keychain items", () => {
  // covers ADR 020, ADR 022
  it("[TC-OP-1214-01] moves what the hub's records say it stored into its own items, and leaves the rest", async () => {
    const moved = await claim(records([FRODO], "app"), sharedItems);
    expect(moved).toEqual({
      problems: [],
      signIn: Option.some("dG9rZW5z"),
      frodoKey: Option.some("frodo's key"),
      samKey: Option.none(),
      // Sam has no app on this hub, so his key may be another hub's.
      shared: { signIn: Option.none(), frodoKey: Option.none(), samKey: Option.some("sam's key") },
    });

    // A hub on the gh sign-in, or with no GitHub at all, stored no sign-in: the shared one is another hub's.
    for (const source of ["gh", null] as const) {
      const left = await claim(records([], source), sharedItems);
      expect(left.signIn).toEqual(Option.none());
      expect(left.shared.signIn).toEqual(Option.some("dG9rZW5z"));
    }
  });

  it("[TC-OP-1214-02] keeps a sign-in the hub already has, and only finishes a move that stopped halfway", async () => {
    // The hub's own item differs, so the shared one is another hub's and stays.
    const kept = await claim(
      records([], "app"),
      Effect.gen(function* () {
        yield* sharedItems;
        yield* (yield* Keychain).write(Redacted.make("bWluZQ"));
      }),
    );
    expect(kept.signIn).toEqual(Option.some("bWluZQ"));
    expect(kept.shared.signIn).toEqual(Option.some("dG9rZW5z"));

    // The same secret in both: an earlier move wrote the hub's item and stopped before its delete.
    const finished = await claim(
      records([], "app"),
      Effect.gen(function* () {
        yield* sharedItems;
        yield* (yield* Keychain).write(Redacted.make("dG9rZW5z"));
      }),
    );
    expect(finished.signIn).toEqual(Option.some("dG9rZW5z"));
    expect(finished.shared.signIn).toEqual(Option.none());
  });

  it("[TC-OP-1214-03] lets the hub start when the keychain refuses, and says what is left in the shared items", async () => {
    const locked = new KeychainError({ reason: "failed", message: "The keychain is locked." });
    const refusing = Layer.succeed(Keychain, {
      read: Effect.succeed(Option.none()),
      write: () => Effect.fail(locked),
      remove: Effect.fail(locked),
    });
    const outcome = await Effect.gen(function* () {
      yield* sharedItems;
      const problems = yield* claimLegacySignIns(newLock());
      return { problems, shared: value(yield* (yield* LegacyKeychain).signIn.read) };
    }).pipe(
      Effect.provide(Layer.mergeAll(refusing, HobAppKeysMemory, LegacyKeychainMemory, records([], "app"))),
      Effect.runPromise,
    );
    expect(outcome).toEqual({
      problems: ["The GitHub sign-in may still be in the keychain item every hub shared: The keychain is locked."],
      shared: Option.some("dG9rZW5z"),
    });
  });

  it("[TC-OP-1214-04] the reset command deletes nothing while a moved sign-in is still in the shared item", async () => {
    // The hub's own item takes the sign-in, then the keychain refuses to delete the shared one.
    const refused = new KeychainError({ reason: "failed", message: "The keychain refused the delete (161)." });
    const stuck = Layer.effect(
      LegacyKeychain,
      Effect.gen(function* () {
        const legacy = yield* LegacyKeychain;
        return LegacyKeychain.of({ ...legacy, signIn: { ...legacy.signIn, remove: Effect.fail(refused) } });
      }),
    ).pipe(Layer.provide(LegacyKeychainMemory));
    const outcome = await Effect.gen(function* () {
      yield* sharedItems;
      const kept = yield* forgetKeychain([], newLock());
      return {
        kept,
        own: value(yield* (yield* Keychain).read),
        shared: value(yield* (yield* LegacyKeychain).signIn.read),
      };
    }).pipe(
      Effect.provide(Layer.mergeAll(KeychainMemory, HobAppKeysMemory, stuck, records([], "app"))),
      Effect.runPromise,
    );
    // Neither copy is erased, so the hub's records still say a sign-in is there and a retry finds it.
    expect(outcome).toEqual({
      kept: [
        "The GitHub sign-in may still be in the keychain item every hub shared: The keychain refused the delete (161).",
      ],
      own: Option.some("dG9rZW5z"),
      shared: Option.some("dG9rZW5z"),
    });
  });

  it("[TC-OP-1214-05] of two hubs moving at once, only one takes the shared sign-in", async () => {
    const lock = newLock();
    const outcome = await Effect.gen(function* () {
      const shared = yield* LegacyKeychain;
      yield* shared.signIn.write(Redacted.make("dG9rZW5z"));
      // A slow keychain, so both hubs would read the item before either deleted it.
      const slow = LegacyKeychain.of({
        ...shared,
        signIn: { ...shared.signIn, read: shared.signIn.read.pipe(Effect.tap(() => Effect.sleep("50 millis"))) },
      });
      const hub = Effect.gen(function* () {
        yield* claimLegacySignIns(lock);
        return value(yield* (yield* Keychain).read);
      }).pipe(
        Effect.provide(Layer.mergeAll(KeychainMemory, HobAppKeysMemory, records([], "app"))),
        Effect.provideService(LegacyKeychain, slow),
      );
      const [first, second] = yield* Effect.all([hub, hub], { concurrency: 2 });
      return { first, second, shared: value(yield* shared.signIn.read) };
    }).pipe(Effect.provide(LegacyKeychainMemory), Effect.runPromise);
    expect([outcome.first, outcome.second].filter(Option.isSome)).toEqual([Option.some("dG9rZW5z")]);
    expect(outcome.shared).toEqual(Option.none());
  });

  it("[TC-OP-1214-06] waits for a hub holding the lock, and takes over one a stopped hub left", async () => {
    const run = (lock: string) =>
      Effect.gen(function* () {
        yield* sharedItems;
        return yield* claimLegacySignIns(lock, 200);
      }).pipe(
        Effect.provide(Layer.mergeAll(KeychainMemory, HobAppKeysMemory, LegacyKeychainMemory, records([], "app"))),
        Effect.runPromise,
      );
    // Held by a live process (this one): the move waits, then says so and moves nothing.
    const held = newLock();
    mkdirSync(held);
    writeFileSync(join(held, "pid"), `${process.pid}\n`);
    expect(await run(held)).toEqual([
      "Another hub on this computer is moving its sign-ins out of the keychain items every hub shared. Try again once it has started.",
    ]);
    // Left by a process that is gone: taken over.
    const left = newLock();
    mkdirSync(left);
    writeFileSync(join(left, "pid"), "2147483646\n");
    expect(await run(left)).toEqual([]);
  });
});
