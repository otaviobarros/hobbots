import { ChatService, HobAdmission, HobbotsRepository, HobLifecycle, HobTools, WorkHold } from "@hobbots/agents";
import { MessageNotQueued } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type HobbotsEvent,
  Message,
  MessageId,
  mainLine,
  OWNER_ACTOR,
  Channel,
  ChannelId,
} from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Fiber, Layer, Option, Ref, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");
const CHANNEL_ID = ChannelId.make("t-queued");
const at = "2026-01-01T00:00:00.000Z";

const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 4821,
      lookColor: "violet",
      configVersion: 1,
      createdAt: at,
    }),
  );
});

// What a previous process left behind: a finished turn and two messages still waiting.
const leftQueued = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.upsertChannel(
    new Channel({
      id: CHANNEL_ID,
      agentId: HOB_ID,
      title: "Plans",
      createdAt: at,
      updatedAt: at,
    }),
  );
  const message = (id: string, role: Message["role"], status: Message["status"]) =>
    new Message({
      id: MessageId.make(id),
      channelId: CHANNEL_ID,
      actor: role === "assistant" ? null : OWNER_ACTOR,
      role,
      content: id,
      status,
      error: null,
      configVersion: role === "assistant" ? 1 : null,
      createdAt: at,
    });
  yield* repo.upsertMessage(message("first", "user", "complete"));
  yield* repo.upsertMessage(message("reply", "assistant", "interrupted"));
  // Each was sent while the reply ran, so each waits with a request for the floor (ADR 039).
  yield* repo.sendMessage(message("second", "user", "queued"), { mentions: [], repliesTo: null }).pipe(Effect.orDie);
  yield* repo.sendMessage(message("third", "user", "queued"), { mentions: [], repliesTo: null }).pipe(Effect.orDie);
});

/**
 * A reply in a channel whose session is not recorded, as these seeded channels' are: a new session,
 * so the fake echoes its context pack, the live chapter so far, ahead of the prompt (ADR 037).
 */
const packedEcho = (prompt: string) =>
  expect.stringMatching(new RegExp(`^Echo: ## This chapter so far\\n[\\s\\S]*\\n\\n${prompt}$`));

// What a crash right after a queued message started leaves: it and its reply are saved together,
// so the reply is still streaming, and a later message is still queued.
const crashedAfterStart = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* leftQueued;
  const second = yield* repo.nextQueuedMessage(CHANNEL_ID).pipe(Effect.map(Option.getOrThrow));
  // Its request took the floor in the same transaction.
  const [request] = yield* repo.openTurnRequests(mainLine(CHANNEL_ID));
  yield* repo.startQueuedMessage(
    new Message({ ...second, status: "complete" }),
    new Message({
      ...second,
      id: MessageId.make("second-reply"),
      role: "assistant",
      content: "Ech",
      status: "streaming",
      configVersion: 1,
    }),
    request === undefined ? [] : [request.id],
  );
});

const testLayer = (seed: Effect.Effect<void, never, HobbotsRepository> = Effect.void) =>
  HobLifecycle.layer.pipe(
    Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly))),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effectDiscard(Effect.andThen(summonHob, seed)).pipe(
          Layer.provideMerge(HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabase))),
        ),
        EventBus.layer,
        HobAdmission.layer,
        // Slow enough that a reply is still running when the next message is sent.
        FakeRuntimeLayer({ delay: "15 millis" }),
      ),
    ),
  );

// Waits until the channel ends on a finished reply with nothing streaming or queued and no turn running.
const settled = (channelId: ChannelId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const messages = yield* repo.listMessages(channelId);
    const active = yield* chat.activeChannels;
    const unfinished = messages.some((m) => m.status === "streaming" || m.status === "queued");
    if (unfinished || messages.at(-1)?.role !== "assistant" || active.length > 0) {
      return yield* Effect.fail("busy" as const);
    }
  }).pipe(Effect.retry(Schedule.spaced("5 millis")));

const transcript = (channelId: ChannelId) =>
  HobbotsRepository.use((repo) => repo.listMessages(channelId)).pipe(
    Effect.map((messages) => messages.map((m) => [m.role, m.content, m.status])),
  );

// Records the queue events published from here on.
const recordQueueEvents = Effect.gen(function* () {
  const bus = yield* EventBus;
  const events: Array<Extract<HobbotsEvent, { _tag: "MessageQueued" | "MessageDequeued" }>> = [];
  yield* bus.stream.pipe(
    Stream.runForEach((published) =>
      Effect.sync(() => {
        if (published._tag !== "Journaled") return;
        const event = published.entry.payload;
        if (event._tag === "MessageQueued" || event._tag === "MessageDequeued") events.push(event);
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return events;
});

describe("message queue", () => {
  it("queues messages sent during a reply and starts them one at a time, in order", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const events = yield* recordQueueEvents;
      const channel = yield* chat.createChannel(HOB_ID);

      const first = yield* chat.sendPrompt(channel.id, "one");
      const second = yield* chat.sendPrompt(channel.id, "two");
      const third = yield* chat.sendPrompt(channel.id, "three");
      yield* settled(channel.id);
      return {
        replies: [first.assistantMessage, second.assistantMessage, third.assistantMessage].map((m) => m?.status),
        queued: [second.userMessage.status, third.userMessage.status],
        transcript: yield* transcript(channel.id),
        events: events.map((e) => (e._tag === "MessageQueued" ? [e._tag, e.message.content] : [e._tag, e.reason])),
      };
    }).pipe(Effect.provide(testLayer()), Effect.scoped, Effect.runPromise);

    expect(result.replies).toEqual(["streaming", undefined, undefined]);
    expect(result.queued).toEqual(["queued", "queued"]);
    expect(result.transcript).toEqual([
      ["user", "one", "complete"],
      ["assistant", "Echo: one", "complete"],
      ["user", "two", "complete"],
      ["assistant", "Echo: two", "complete"],
      ["user", "three", "complete"],
      ["assistant", "Echo: three", "complete"],
    ]);
    expect(result.events).toEqual([
      ["MessageQueued", "two"],
      ["MessageQueued", "three"],
      ["MessageDequeued", "started"],
      ["MessageDequeued", "started"],
    ]);
  });

  it("starts no queued message while work is held after a restore, and runs them once it resumes", async () => {
    const held = Ref.makeUnsafe(true);
    const hold = Layer.succeed(WorkHold, WorkHold.of({ held: Ref.get(held), release: Ref.set(held, false) }));
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      yield* Effect.sleep("60 millis");
      const whileHeld = yield* transcript(CHANNEL_ID);
      yield* (yield* WorkHold).release;
      yield* chat.drainAgent(HOB_ID);
      yield* settled(CHANNEL_ID);
      return { whileHeld, resumed: yield* transcript(CHANNEL_ID) };
    }).pipe(Effect.provide(testLayer(leftQueued).pipe(Layer.provideMerge(hold))), Effect.scoped, Effect.runPromise);

    expect(result.whileHeld).toEqual([
      ["user", "first", "complete"],
      ["assistant", "reply", "interrupted"],
      ["user", "second", "queued"],
      ["user", "third", "queued"],
    ]);
    expect(result.resumed.map(([, content, status]) => `${content}:${status}`)).toEqual([
      "first:complete",
      "reply:interrupted",
      "second:complete",
      packedEcho("second:complete"),
      "third:complete",
      "Echo: third:complete",
    ]);
  });

  it("starts messages queued before a restart, in order", async () => {
    const result = await Effect.gen(function* () {
      yield* settled(CHANNEL_ID);
      return yield* transcript(CHANNEL_ID);
    }).pipe(Effect.provide(testLayer(leftQueued)), Effect.scoped, Effect.runPromise);

    expect(result).toEqual([
      ["user", "first", "complete"],
      ["assistant", "reply", "interrupted"],
      ["user", "second", "complete"],
      ["assistant", packedEcho("second"), "complete"],
      ["user", "third", "complete"],
      ["assistant", "Echo: third", "complete"],
    ]);
  });

  it("recovers a message that started just before a crash and then runs the rest of the queue", async () => {
    const result = await Effect.gen(function* () {
      yield* settled(CHANNEL_ID);
      return yield* transcript(CHANNEL_ID);
    }).pipe(Effect.provide(testLayer(crashedAfterStart)), Effect.scoped, Effect.runPromise);

    expect(result).toEqual([
      ["user", "first", "complete"],
      ["assistant", "reply", "interrupted"],
      ["user", "second", "complete"],
      ["assistant", "Ech", "interrupted"],
      ["user", "third", "complete"],
      ["assistant", packedEcho("third"), "complete"],
    ]);
  });

  it("Send now stops the running reply and starts the chosen message before older ones", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const channel = yield* chat.createChannel(HOB_ID);

      yield* chat.sendPrompt(channel.id, "long task please keep going for a while");
      yield* chat.sendPrompt(channel.id, "later");
      const urgent = yield* chat.sendPrompt(channel.id, "urgent");
      yield* chat.sendNow(channel.id, urgent.userMessage.id);
      yield* settled(channel.id);
      return yield* transcript(channel.id);
    }).pipe(Effect.provide(testLayer()), Effect.scoped, Effect.runPromise);

    expect(result.map(([role, content, status]) => [role, role === "user" ? content : status])).toEqual([
      ["user", "long task please keep going for a while"],
      ["assistant", "stopped"],
      ["user", "urgent"],
      ["assistant", "complete"],
      ["user", "later"],
      ["assistant", "complete"],
    ]);
  });

  it("removes a queued message before it starts and refuses to remove one that started", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const events = yield* recordQueueEvents;
      const channel = yield* chat.createChannel(HOB_ID);

      const first = yield* chat.sendPrompt(channel.id, "keep");
      const dropped = yield* chat.sendPrompt(channel.id, "drop");
      yield* chat.removeQueued(channel.id, dropped.userMessage.id);
      const again = yield* chat.removeQueued(channel.id, dropped.userMessage.id).pipe(Effect.flip);
      const started = yield* chat.removeQueued(channel.id, first.userMessage.id).pipe(Effect.flip);
      yield* settled(channel.id);
      return {
        again,
        started,
        transcript: yield* transcript(channel.id),
        events: events.map((e) => (e._tag === "MessageDequeued" ? [e._tag, e.reason] : [e._tag])),
      };
    }).pipe(Effect.provide(testLayer()), Effect.scoped, Effect.runPromise);

    expect(result.again).toBeInstanceOf(MessageNotQueued);
    expect(result.started).toBeInstanceOf(MessageNotQueued);
    expect(result.transcript).toEqual([
      ["user", "keep", "complete"],
      ["assistant", "Echo: keep", "complete"],
    ]);
    expect(result.events).toEqual([["MessageQueued"], ["MessageDequeued", "removed"]]);
  });

  it("queues messages for a paused hob, also ones sent while paused, and runs them in order once it wakes", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const lifecycle = yield* HobLifecycle;
      const channel = yield* chat.createChannel(HOB_ID);

      yield* chat.sendPrompt(channel.id, "now");
      yield* chat.sendPrompt(channel.id, "after the nap");
      yield* lifecycle.pause(HOB_ID);
      // The running reply finishes; the queued message waits for the hob.
      yield* HobbotsRepository.use((repo) => repo.listMessages(channel.id)).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.status === "streaming") ? Effect.fail("streaming" as const) : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      const sentWhilePaused = yield* chat.sendPrompt(channel.id, "and this");
      yield* Effect.sleep("50 millis");
      const whilePaused = yield* transcript(channel.id);
      const woke = yield* Effect.forkChild(lifecycle.wake(HOB_ID));
      yield* Fiber.join(woke);
      yield* settled(channel.id);
      return { sentWhilePaused, whilePaused, afterWake: yield* transcript(channel.id) };
    }).pipe(Effect.provide(testLayer()), Effect.scoped, Effect.runPromise);

    expect(result.whilePaused).toEqual([
      ["user", "now", "complete"],
      ["assistant", "Echo: now", "complete"],
      ["user", "after the nap", "queued"],
      ["user", "and this", "queued"],
    ]);
    expect(result.sentWhilePaused.assistantMessage).toBeNull();
    expect(result.afterWake.slice(2)).toEqual([
      ["user", "after the nap", "complete"],
      ["assistant", "Echo: after the nap", "complete"],
      ["user", "and this", "complete"],
      ["assistant", "Echo: and this", "complete"],
    ]);
  });
});
