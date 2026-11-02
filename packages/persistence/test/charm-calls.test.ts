import { CharmCallService, CharmCalls, HobbotsRepository } from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import { Agent, AgentId, CharmCall, MessageId, ThreadId, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CharmCallsLive, EventJournal, HobbotsRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = CharmCallService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive, CharmCallsLive, EventJournal.layer)),
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | CharmCalls | CharmCallService>) =>
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
    attempt: `${key}-1`,
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
        const applied = yield* calls.settle(call("k1"), "applied", "Pushed.", later);
        // A late outcome never overwrites a settled call.
        const late = yield* calls.settle(call("k1"), "uncertain", null, later);
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
        yield* calls.settle(call("k1"), "uncertain", "Unclear.", later);
        const blocked = yield* calls.begin(call("k2"));
        const elsewhere = yield* calls.begin(call("k3", { site: "github.com/octo/app refs/heads/other" }));
        const unsettled = yield* calls.unsettled;
        yield* calls.settle(call("k1"), "applied", "Pushed.", later);
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
        yield* calls.settle(call("k1"), "not-sent", "Not sent.", later);
        const other = yield* calls.begin(call("k1", { input: `{"branch":"feat/y"}` }));
        const same = yield* calls.begin(call("k1"));
        return { other, same, stored: yield* calls.find(agentId, "k1") };
      }),
    );
    expect(result.other._tag === "Existing" && result.other.call.state).toBe("not-sent");
    expect(result.same._tag).toBe("Started");
    expect(Option.getOrThrow(result.stored).state).toBe("sending");
  });

  // covers IN-003, EX-003
  it("[TC-IN-056] settles a sending once when outcomes race, and never from an earlier sending of a reused key", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const calls = yield* CharmCalls;
        yield* calls.begin(call("k1"));
        yield* calls.settle(call("k1"), "uncertain", "Unclear.", later);
        // Reading GitHub back and the user settle the same sending at once: only one lands.
        const raced = yield* Effect.all(
          [
            calls.settle(call("k1"), "applied", "Pushed.", later),
            calls.settle(call("k1"), "not-sent", "Not sent.", later),
          ],
          { concurrency: "unbounded" },
        );
        const afterRace = yield* calls.find(agentId, "k1");
        // A key that was not sent is sent again: a late outcome of the first sending must not land.
        yield* calls.begin(call("k2"));
        yield* calls.settle(call("k2"), "not-sent", "Not sent.", later);
        yield* calls.begin(call("k2", { attempt: "k2-2" }));
        const stale = yield* calls.settle(call("k2"), "applied", "Pushed.", later);
        const current = yield* calls.find(agentId, "k2");
        return { raced, afterRace, stale, current };
      }),
    );
    expect(result.raced.filter(Option.isSome)).toHaveLength(1);
    const landed = result.raced.find(Option.isSome);
    expect(Option.getOrThrow(result.afterRace).state).toBe(landed === undefined ? null : landed.value.state);
    expect(Option.isNone(result.stale)).toBe(true);
    expect(Option.getOrThrow(result.current)).toMatchObject({ attempt: "k2-2", state: "sending", result: null });
  });

  // covers EX-003, PE-006
  it("[TC-IN-054] lets the user settle an uncertain call from its step, once, and nothing else", async () => {
    const user = Layer.succeed(UserSession, {
      deviceId: WINDOW_DEVICE_ID,
      name: "This computer's Hobbots window",
      kind: "window",
      whileApproved: (write) => write,
    });
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const calls = yield* CharmCalls;
        const service = yield* CharmCallService;
        const step = (stepId: string) => [ThreadId.make("t1"), MessageId.make("m1"), stepId] as const;
        yield* calls.begin(call("k1"));
        const sending = yield* service.settle(...step("toolu_1"), "applied").pipe(Effect.flip, Effect.provide(user));
        yield* calls.settle(call("k1"), "uncertain", "Unclear.", later);
        const settled = yield* service.settle(...step("toolu_1"), "not-sent").pipe(Effect.provide(user));
        const again = yield* service.settle(...step("toolu_1"), "applied").pipe(Effect.flip, Effect.provide(user));
        const missing = yield* service.settle(...step("toolu_9"), "applied").pipe(Effect.flip, Effect.provide(user));
        // Not sent frees the key: the same call may be made again.
        const retried = yield* calls.begin(call("k1"));
        return { sending, settled, again, missing, retried, listed: yield* service.listForThread(ThreadId.make("t1")) };
      }),
    );
    expect(result.sending).toMatchObject({ _tag: "CharmCallSettled", state: "sending" });
    expect(result.settled).toMatchObject({ state: "not-sent", result: expect.stringContaining("not sent") });
    expect(result.again).toMatchObject({ _tag: "CharmCallSettled", state: "not-sent" });
    expect(result.missing._tag).toBe("CharmCallNotFound");
    expect(result.retried._tag).toBe("Started");
    expect(result.listed.map((c) => c.key)).toEqual(["k1"]);
  });
});
