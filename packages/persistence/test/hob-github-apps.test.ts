import { HobbotsRepository, HobGitHubApps } from "@hobbots/agents";
import { Agent, AgentId, type HobGitHubApp } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { HobbotsRepositoryLive, HobGitHubAppRepository } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, HobGitHubAppRepository).pipe(Layer.provideMerge(TestDatabase));
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | HobGitHubApps>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-02T00:00:00.000Z";

const seed = (id: string) =>
  Effect.flatMap(HobbotsRepository, (repo) =>
    repo.insertAgent(
      new Agent({
        id: AgentId.make(id),
        name: id,
        roleTitle: "Guide",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        configVersion: 1,
        createdAt: now,
      }),
    ),
  );

const app = (overrides: Partial<HobGitHubApp> = {}): HobGitHubApp => ({
  // Past 2^31, as GitHub's IDs may be.
  appId: 3_000_000_001,
  clientId: "Iv23liFrodoClient",
  slug: "frodo-hobbots",
  owner: "otaviobarros",
  origin: "made",
  botUserId: 4_000_000_002,
  htmlUrl: "https://github.com/apps/frodo-hobbots",
  connectedAt: now,
  ...overrides,
});

describe("HobGitHubApps", () => {
  // covers ADR 022
  it("[TC-GEN-050] keeps one app per hob, by hob, with 64-bit IDs, keeps one left over, and forgets it", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed("frodo");
        yield* seed("sam");
        const apps = yield* HobGitHubApps;
        const before = yield* apps.get(AgentId.make("frodo"));
        yield* apps.save(AgentId.make("frodo"), app());
        yield* apps.save(AgentId.make("sam"), app({ appId: 7, slug: "sam-hobbots", botUserId: null }));
        // A new app replaces the hob's old one.
        yield* apps.save(AgentId.make("frodo"), app({ slug: "frodo-hobbots-2" }));
        const frodo = yield* apps.get(AgentId.make("frodo"));
        const sam = yield* apps.get(AgentId.make("sam"));
        // An app left over after a failed removal is shown but no longer acts; a new app clears it.
        yield* apps.leave(AgentId.make("sam"), "1 of the app's installations could not be removed.");
        const samLeft = {
          get: yield* apps.get(AgentId.make("sam")),
          leftOver: yield* apps.leftOver(AgentId.make("sam")),
        };
        yield* apps.save(AgentId.make("sam"), app({ appId: 8, slug: "sam-hobbots-2", botUserId: null }));
        const samAgain = yield* apps.leftOver(AgentId.make("sam"));
        yield* apps.remove(AgentId.make("frodo"));
        return { before, frodo, sam, samLeft, samAgain, after: yield* apps.get(AgentId.make("frodo")) };
      }),
    );
    expect(result.before).toBeNull();
    expect(result.frodo).toEqual(app({ slug: "frodo-hobbots-2" }));
    expect(result.sam).toEqual(app({ appId: 7, slug: "sam-hobbots", botUserId: null }));
    expect(result.samLeft).toEqual({
      get: null,
      leftOver: {
        app: app({ appId: 7, slug: "sam-hobbots", botUserId: null }),
        problem: "1 of the app's installations could not be removed.",
      },
    });
    expect(result.samAgain).toBeNull();
    expect(result.after).toBeNull();
  });
});

describe("HobGitHubApps for a linked app", () => {
  // covers #1321, ADR 022
  it("[TC-GEN-407] keeps whether the hub made a hob's app or the user linked it, and finds the hob that has an app", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed("frodo");
        yield* seed("sam");
        const apps = yield* HobGitHubApps;
        yield* apps.save(AgentId.make("frodo"), app({ origin: "linked", owner: "the-fellowship" }));
        yield* apps.save(AgentId.make("sam"), app({ appId: 9, slug: "sam-hobbots" }));
        yield* apps.leave(AgentId.make("sam"), "The keychain kept the key.");
        return {
          frodo: yield* apps.get(AgentId.make("frodo")),
          frodoHolds: yield* apps.holder(3_000_000_001),
          // A left-over app is still the hob's, so no other hob takes it.
          samHolds: yield* apps.holder(9),
          nobody: yield* apps.holder(10),
        };
      }),
    );
    expect(result.frodo).toEqual(app({ origin: "linked", owner: "the-fellowship" }));
    expect(result.frodoHolds).toBe("frodo");
    expect(result.samHolds).toBe("sam");
    expect(result.nobody).toBeNull();
  });
});
