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
  botUserId: 4_000_000_002,
  htmlUrl: "https://github.com/apps/frodo-hobbots",
  connectedAt: now,
  ...overrides,
});

describe("HobGitHubApps", () => {
  // covers ADR 022
  it("[TC-GEN-050] keeps one app per hob, by hob, with 64-bit IDs, and forgets it", async () => {
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
        yield* apps.remove(AgentId.make("frodo"));
        return { before, frodo, sam, after: yield* apps.get(AgentId.make("frodo")) };
      }),
    );
    expect(result.before).toBeNull();
    expect(result.frodo).toEqual(app({ slug: "frodo-hobbots-2" }));
    expect(result.sam).toEqual(app({ appId: 7, slug: "sam-hobbots", botUserId: null }));
    expect(result.after).toBeNull();
  });
});
