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
import { describe, expect, it } from "vitest";
import { claimLegacySignIns } from "../src/legacy-keychain.ts";

// Moving a hub's sign-ins out of the keychain items every hub on the computer shared (#1214).

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
    yield* claimLegacySignIns;
    const own = yield* Keychain;
    const keys = yield* HobAppKeys;
    const legacy = yield* LegacyKeychain;
    return {
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

  it("[TC-OP-1214-03] lets the hub start when the keychain refuses, and leaves the shared items for the next start", async () => {
    const locked = new KeychainError({ reason: "failed", message: "The keychain is locked." });
    const refusing = Layer.succeed(Keychain, {
      read: Effect.succeed(Option.none()),
      write: () => Effect.fail(locked),
      remove: Effect.fail(locked),
    });
    const left = await Effect.gen(function* () {
      yield* sharedItems;
      yield* claimLegacySignIns;
      return value(yield* (yield* LegacyKeychain).signIn.read);
    }).pipe(
      Effect.provide(Layer.mergeAll(refusing, HobAppKeysMemory, LegacyKeychainMemory, records([], "app"))),
      Effect.runPromise,
    );
    expect(left).toEqual(Option.some("dG9rZW5z"));
  });
});
