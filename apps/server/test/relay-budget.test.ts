import { ChatService, HobAdmission, HobbotsRepository, HobTools, ChannelMemberRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  HOB_RELAY_BUDGET,
  hobActor,
  isInProgress,
  type Message,
  OWNER_ACTOR,
  Channel,
  ChannelId,
  TurnRequests,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, ChannelMemberRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Context, Effect, Layer, PubSub, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

// Issue #1463 (ADR 039, Hobs talking to hobs): a hob's reply that @mentions another hob of the camp
// wakes it, one relay deeper than the turn that mentioned it. After a person's message hobs may wake
// each other for HOB_RELAY_BUDGET turns; the next relay waits for a person, who lets them go on for
// that many turns again, or writes, which drops what waited.
//
// The fake runtime echoes its prompt, and a relayed turn's prompt is the reply that mentioned its
// hob, so two hobs that mention each other keep mentioning each other until the budget stops them.

const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const CAMP = ChannelId.make("camp");
const NOW = "2026-11-14T10:00:00.000Z";

const hob = (id: AgentId) =>
  new Agent({
    id,
    name: id,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: `You are ${id}.`,
    lookSeed: 4821,
    lookColor: "violet",
    configVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

/** Quill's camp, which Pip joined. */
const campOfTwo = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const members = yield* ChannelMemberRepository;
  for (const id of [QUILL, PIP]) yield* repo.insertAgent(hob(id));
  yield* repo.upsertChannel(
    new Channel({ id: CAMP, agentId: QUILL, title: "Launch", kind: "camp", createdAt: NOW, updatedAt: NOW }),
  );
  yield* members.add(CAMP, hobActor(PIP), OWNER_ACTOR);
});

const camp = Layer.mergeAll(
  Layer.effectDiscard(Effect.orDie(campOfTwo)).pipe(
    Layer.provideMerge(
      Layer.mergeAll(HobbotsRepositoryLive, ChannelMemberRepositoryLive).pipe(Layer.provideMerge(TestDatabase)),
    ),
  ),
  EventBus.layer,
  HobAdmission.layer,
  FakeRuntimeLayer({ delay: "2 millis" }),
);

const hub = ChatService.layer.pipe(Layer.provide(HobTools.chatOnly), Layer.provideMerge(camp));

/**
 * The camp's hub where, under LateRead, the first read of what is owed sees none of the speaking turn's
 * own request, as for a turn that answers none (a carried backpack's), and returns only after that
 * turn's reply is saved complete: Stop all reads, the turn ends and relays, then the stop comes.
 */
const LateRead = Context.Reference<{ armed: boolean }>("test/LateRead", { defaultValue: () => ({ armed: false }) });
const LateReads = Layer.effect(
  HobbotsRepository,
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const replied = repo.listMessages(CAMP).pipe(
      Effect.flatMap((messages) =>
        messages.some((m) => m.role === "assistant" && m.status === "complete") ? Effect.void : Effect.fail("not yet"),
      ),
      Effect.retry(Schedule.spaced("2 millis")),
      Effect.orDie,
    );
    const openTurnRequests: typeof repo.openTurnRequests = (at) =>
      Effect.gen(function* () {
        const open = yield* repo.openTurnRequests(at);
        const late = yield* LateRead;
        if (!late.armed) return open;
        late.armed = false;
        yield* replied;
        return open.filter((request) => request !== TurnRequests.speaking(open));
      });
    return { ...repo, openTurnRequests };
  }),
);
const lateHub = ChatService.layer.pipe(
  Layer.provide(HobTools.chatOnly),
  Layer.provide(LateReads),
  Layer.provideMerge(camp),
);

/** The camp's line as the hub publishes it now; null when it publishes none. */
const line = Effect.flatMap(ChatService, (chat) =>
  chat.channelRuns.pipe(Effect.map(({ runs }) => runs.find((run) => run.channelId === CAMP) ?? null)),
);

/** Waits until no turn runs or waits in the camp: what is still owed is paused, if anything. */
const settled = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const chat = yield* ChatService;
  yield* Effect.gen(function* () {
    const messages = yield* repo.listMessages(CAMP);
    const owed = yield* repo.openTurnRequests({ channelId: CAMP, rootMessageId: null });
    const running = yield* chat.activeChannels;
    // The line rests once the last turn's end has moved the floor on.
    const run = (yield* line)?.run ?? "idle";
    const busy =
      owed.some((request) => request.state !== "paused") ||
      running.length > 0 ||
      run !== "idle" ||
      messages.some((m) => isInProgress(m.status));
    if (busy) return yield* Effect.fail("busy" as const);
  }).pipe(Effect.retry(Schedule.spaced("5 millis")));
  return yield* repo.listMessages(CAMP);
});

/** Every request in the camp, as stored, oldest first. */
const allRequests = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{
    readonly hobId: string;
    readonly causedById: string;
    readonly relayDepth: unknown;
    readonly state: string;
    readonly droppedById: string | null;
  }>`SELECT hob_id, caused_by_id, relay_depth, state, dropped_by_id FROM turn_requests
    WHERE channel_id = ${CAMP} ORDER BY queued_at, position`.pipe(
    Effect.map((rows) => rows.map((row) => ({ ...row, relayDepth: Number(row.relayDepth) }))),
    Effect.orDie,
  ),
);

const hobReplies = (messages: ReadonlyArray<Message>) =>
  messages.filter((m) => m.role === "assistant").map((m) => [m.actor?.id, m.status]);

describe("the relay budget", () => {
  // covers ADR 039 (Hobs talking to hobs)
  it("stops two hobs that mention each other after 3 turns, and says they wait for a person (#1463)", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      yield* chat.sendPrompt(CAMP, "@quill @pip work out the launch checklist between you");
      const messages = yield* settled;
      return { messages, requests: yield* allRequests, line: yield* line };
    }).pipe(Effect.provide(hub), Effect.scoped, Effect.runPromise);

    expect(HOB_RELAY_BUDGET).toBe(3);
    // Each hob answers you, then each answer starts a relay of 3 turns: Quill's goes to Pip and back
    // and to Pip again, Pip's the other way.
    const byHob = result.requests.map((r) => [r.hobId, r.causedById, r.relayDepth, r.state]);
    expect(byHob.filter(([, , depth]) => depth === 0)).toEqual([
      [QUILL, OWNER_ACTOR.id, 0, "answered"],
      [PIP, OWNER_ACTOR.id, 0, "answered"],
    ]);
    for (const depth of [1, 2, 3]) {
      expect(byHob.filter(([, , d]) => d === depth).map(([, , , state]) => state)).toEqual(["answered", "answered"]);
    }
    // The fourth relay of each waits, paused, and wakes nobody.
    expect(byHob.filter(([, , depth]) => (depth as number) > HOB_RELAY_BUDGET).map(([, , d, s]) => [d, s])).toEqual([
      [4, "paused"],
      [4, "paused"],
    ]);
    expect(hobReplies(result.messages)).toHaveLength(2 + 2 * HOB_RELAY_BUDGET);
    expect(hobReplies(result.messages).every(([, status]) => status === "complete")).toBe(true);
    // The line says whose relay waits for a person, and nobody is next.
    expect(result.line?.run).toBe("idle");
    expect(result.line?.next).toEqual([]);
    expect([...(result.line?.paused ?? [])].sort()).toEqual([PIP, QUILL]);
  }, 30_000);

  // covers ADR 039 (Hobs talking to hobs)
  it("Let them go on gives the paused hobs 3 more turns, the resumed one first, journaled once (#1463)", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const bus = yield* EventBus;
      yield* chat.sendPrompt(CAMP, "@quill @pip work out the launch checklist between you");
      yield* settled;
      const subscription = yield* bus.subscribe;
      yield* chat.letHobsGoOn(CAMP);
      const messages = yield* settled;
      const resets = (yield* PubSub.takeAll(subscription)).flatMap((event) =>
        event._tag === "Journaled" && event.entry.payload._tag === "RelayBudgetReset" ? [event.entry.payload] : [],
      );
      // Asked again with nothing paused since, it changes nothing.
      return { messages, requests: yield* allRequests, line: yield* line, resets };
    }).pipe(Effect.provide(hub), Effect.scoped, Effect.runPromise);

    // 3 more turns in each relay, and the next waits for a person again.
    expect(hobReplies(result.messages)).toHaveLength(2 + 4 * HOB_RELAY_BUDGET);
    const paused = result.requests.filter((r) => r.state === "paused");
    expect(paused.map((r) => r.relayDepth)).toEqual([4, 4]);
    expect(result.requests.filter((r) => r.state !== "answered" && r.state !== "paused")).toEqual([]);
    expect(result.resets).toHaveLength(1);
    expect(result.resets[0]).toMatchObject({ channelId: CAMP, rootMessageId: null, by: OWNER_ACTOR });
    expect((result.resets[0] as { readonly requests: ReadonlyArray<string> }).requests).toHaveLength(2);
    expect(result.line?.paused).toHaveLength(2);
  }, 30_000);

  // covers ADR 039 (Hobs talking to hobs)
  it("drops the paused relays when a person writes, and the line stops saying they wait (#1463)", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      yield* chat.sendPrompt(CAMP, "@quill @pip work out the launch checklist between you");
      yield* settled;
      // Nobody is mentioned in a camp of two hobs, so nobody answers: you only took over.
      yield* chat.sendPrompt(CAMP, "Thanks, I'll take it from here.");
      const messages = yield* settled;
      yield* chat.letHobsGoOn(CAMP);
      return { messages: yield* settled, before: messages, requests: yield* allRequests, line: yield* line };
    }).pipe(Effect.provide(hub), Effect.scoped, Effect.runPromise);

    const dropped = result.requests.filter((r) => r.state === "dropped");
    expect(dropped.map((r) => [r.relayDepth, r.droppedById])).toEqual([
      [4, OWNER_ACTOR.id],
      [4, OWNER_ACTOR.id],
    ]);
    expect(result.requests.filter((r) => r.state === "paused")).toEqual([]);
    // Let them go on with nothing paused starts nothing.
    expect(hobReplies(result.messages)).toHaveLength(hobReplies(result.before).length);
    expect(result.line?.paused ?? []).toEqual([]);
  }, 30_000);

  // covers ADR 039 (Hobs talking to hobs, Stop all)
  it("Stop all drops the relays of a turn that ended after it read what was owed (#1463)", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      yield* chat.sendPrompt(CAMP, "@quill @pip work out the launch checklist between you");
      yield* repo.listMessages(CAMP).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.role === "assistant" && m.status === "streaming")
            ? Effect.void
            : Effect.fail("not yet"),
        ),
        Effect.retry(Schedule.spaced("1 millis")),
      );
      yield* chat.stopAll(CAMP).pipe(Effect.provideService(LateRead, { armed: true }));
      return { messages: yield* settled, requests: yield* allRequests };
    }).pipe(Effect.provide(lateHub), Effect.scoped, Effect.runPromise);

    // The turn completed before the stop reached it, so only its reply was said.
    expect(hobReplies(result.messages)).toEqual([[QUILL, "complete"]]);
    // Pip's answer to you and the relay Quill's reply wrote are both dropped, by you.
    expect(result.requests.map((r) => [r.hobId, r.relayDepth, r.state, r.droppedById])).toEqual([
      [QUILL, 0, "answered", null],
      [PIP, 0, "dropped", OWNER_ACTOR.id],
      [PIP, 1, "dropped", OWNER_ACTOR.id],
    ]);
  }, 30_000);
});
