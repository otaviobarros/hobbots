import { CharmCalls, HobbotsRepository } from "@hobbots/agents";
import { Agent, AgentId, CharmCall, MessageId, ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CharmCallsLive, EventJournal, HobbotsRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, CharmCallsLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | CharmCalls>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-02T00:00:00.000Z";
const later = "2026-11-02T00:05:00.000Z";
const agentId = AgentId.make("aldric");

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: agentId,
      name: "Aldric",
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
  );
});

const call = (key: string, overrides: Partial<CharmCall> = {}) =>
  new CharmCall({
    agentId,
    key,
    tool: "github_push",
    input: `{"branch":"feat/x"}`,
    site: "github.com/octo/app refs/heads/feat/x",
    plan: `{"commit":"${"a".repeat(40)}"}`,
    state: "sending",
    result: null,
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    stepId: "toolu_1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

describe("Charm call records", () => {
  // covers IN-003, EX-003
  it("[TC-IN-050] records a call once per key, returns it for the same key, and settles it once", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const calls = yield* CharmCalls;
        const first = yield* calls.begin(call("k1"));
        const again = yield* calls.begin(call("k1"));
        const applied = yield* calls.settle(agentId, "k1", "applied", "Pushed.", later);
        // A late outcome never overwrites a settled call.
        const late = yield* calls.settle(agentId, "k1", "uncertain", null, later);
        const stored = yield* calls.find(agentId, "k1");
        const byStep = yield* calls.findByStep(ThreadId.make("t1"), MessageId.make("m1"), "toolu_1");
        return { first, again, applied, late, stored, byStep };
      }),
    );
    expect(result.first._tag).toBe("Started");
    expect(result.again._tag === "Existing" && result.again.call.state).toBe("sending");
    expect(Option.getOrThrow(result.applied).state).toBe("applied");
    expect(Option.isNone(result.late)).toBe(true);
    expect(Option.getOrThrow(result.stored)).toMatchObject({ state: "applied", result: "Pushed.", updatedAt: later });
    expect(Option.getOrThrow(result.byStep).key).toBe("k1");
  });

  // covers IN-003, EX-004
  it("[TC-IN-051] blocks another call on a site while one is sending or uncertain, and frees it once settled", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const calls = yield* CharmCalls;
        yield* calls.begin(call("k1"));
        yield* calls.settle(agentId, "k1", "uncertain", "Unclear.", later);
        const blocked = yield* calls.begin(call("k2"));
        const elsewhere = yield* calls.begin(call("k3", { site: "github.com/octo/app refs/heads/other" }));
        const unsettled = yield* calls.unsettled;
        yield* calls.settle(agentId, "k1", "applied", "Pushed.", later);
        const freed = yield* calls.begin(call("k2"));
        return { blocked, elsewhere, unsettled, freed };
      }),
    );
    expect(result.blocked._tag === "Blocked" && result.blocked.call.key).toBe("k1");
    expect(result.elsewhere._tag).toBe("Started");
    expect(result.unsettled.map((c) => [c.key, c.state])).toEqual([
      ["k1", "uncertain"],
      ["k3", "sending"],
    ]);
    expect(result.freed._tag).toBe("Started");
  });

  // covers IN-003
  it("[TC-IN-052] lets a key that was not sent be used again for the same call, never for another", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const calls = yield* CharmCalls;
        yield* calls.begin(call("k1"));
        yield* calls.settle(agentId, "k1", "not-sent", "Not sent.", later);
        const other = yield* calls.begin(call("k1", { input: `{"branch":"feat/y"}` }));
        const same = yield* calls.begin(call("k1"));
        return { other, same, stored: yield* calls.find(agentId, "k1") };
      }),
    );
    expect(result.other._tag === "Existing" && result.other.call.state).toBe("not-sent");
    expect(result.same._tag).toBe("Started");
    expect(Option.getOrThrow(result.stored).state).toBe("sending");
  });
});
