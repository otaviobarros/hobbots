import { ChatService, HobAdmission, HobbotsRepository, HobLifecycle, HobTools } from "@hobbots/agents";
import { MessageNotQueued } from "@hobbots/api";
import { Agent, AgentId, type HobbotsEvent, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Fiber, Layer, Option, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");
const THREAD_ID = ThreadId.make("t-queued");
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
  yield* repo.upsertThread(
    new Thread({
      id: THREAD_ID,
      agentId: HOB_ID,
      title: "Plans",
      createdAt: at,
      updatedAt: at,
    }),
  );
  const message = (id: string, role: Message["role"], status: Message["status"]) =>
    new Message({
      id: MessageId.make(id),
      threadId: THREAD_ID,
      role,
      content: id,
      status,
      error: null,
      configVersion: role === "assistant" ? 1 : null,
      createdAt: at,
    });
  yield* repo.upsertMessage(message("first", "user", "complete"));
  yield* repo.upsertMessage(message("reply", "assistant", "interrupted"));
  yield* repo.upsertMessage(message("second", "user", "queued"));
  yield* repo.upsertMessage(message("third", "user", "queued"));
});

// What a crash right after a queued message started leaves: it and its reply are saved together,
// so the reply is still streaming, and a later message is still queued.
const crashedAfterStart = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* leftQueued;
  const second = yield* repo.nextQueuedMessage(THREAD_ID).pipe(Effect.map(Option.getOrThrow));
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

// Waits until the thread ends on a finished reply with nothing streaming or queued and no turn running.
const settled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const messages = yield* repo.listMessages(threadId);
    const active = yield* chat.activeThreads;
    const unfinished = messages.some((m) => m.status === "streaming" || m.status === "queued");
    if (unfinished || messages.at(-1)?.role !== "assistant" || active.length > 0) {
      return yield* Effect.fail("busy" as const);
    }
  }).pipe(Effect.retry(Schedule.spaced("5 millis")));

const transcript = (threadId: ThreadId) =>
  HobbotsRepository.use((repo) => repo.listMessages(threadId)).pipe(
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
  // covers CH-008
  it("[TC-CH-006] queues messages sent during a reply and starts them one at a time, in order", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const events = yield* recordQueueEvents;
      const thread = yield* chat.createThread(HOB_ID);

      const first = yield* chat.sendPrompt(thread.id, "one");
      const second = yield* chat.sendPrompt(thread.id, "two");
      const third = yield* chat.sendPrompt(thread.id, "three");
      yield* settled(thread.id);
      return {
        replies: [first.assistantMessage, second.assistantMessage, third.assistantMessage].map((m) => m?.status),
        queued: [second.userMessage.status, third.userMessage.status],
        transcript: yield* transcript(thread.id),
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

  // covers CH-001, CH-008
  it("[TC-CH-007] starts messages queued before a restart, in order", async () => {
    const result = await Effect.gen(function* () {
      yield* settled(THREAD_ID);
      return yield* transcript(THREAD_ID);
    }).pipe(Effect.provide(testLayer(leftQueued)), Effect.scoped, Effect.runPromise);

    expect(result).toEqual([
      ["user", "first", "complete"],
      ["assistant", "reply", "interrupted"],
      ["user", "second", "complete"],
      ["assistant", "Echo: second", "complete"],
      ["user", "third", "complete"],
      ["assistant", "Echo: third", "complete"],
    ]);
  });

  // covers CH-004, CH-008
  it("[TC-CH-013] recovers a message that started just before a crash and then runs the rest of the queue", async () => {
    const result = await Effect.gen(function* () {
      yield* settled(THREAD_ID);
      return yield* transcript(THREAD_ID);
    }).pipe(Effect.provide(testLayer(crashedAfterStart)), Effect.scoped, Effect.runPromise);

    expect(result).toEqual([
      ["user", "first", "complete"],
      ["assistant", "reply", "interrupted"],
      ["user", "second", "complete"],
      ["assistant", "Ech", "interrupted"],
      ["user", "third", "complete"],
      ["assistant", "Echo: third", "complete"],
    ]);
  });

  // covers CH-007, CH-008
  it("[TC-CH-008] Send now stops the running reply and starts the chosen message before older ones", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);

      yield* chat.sendPrompt(thread.id, "long task please keep going for a while");
      yield* chat.sendPrompt(thread.id, "later");
      const urgent = yield* chat.sendPrompt(thread.id, "urgent");
      yield* chat.sendNow(thread.id, urgent.userMessage.id);
      yield* settled(thread.id);
      return yield* transcript(thread.id);
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

  // covers CH-008
  it("[TC-CH-009] removes a queued message before it starts and refuses to remove one that started", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const events = yield* recordQueueEvents;
      const thread = yield* chat.createThread(HOB_ID);

      const first = yield* chat.sendPrompt(thread.id, "keep");
      const dropped = yield* chat.sendPrompt(thread.id, "drop");
      yield* chat.removeQueued(thread.id, dropped.userMessage.id);
      const again = yield* chat.removeQueued(thread.id, dropped.userMessage.id).pipe(Effect.flip);
      const started = yield* chat.removeQueued(thread.id, first.userMessage.id).pipe(Effect.flip);
      yield* settled(thread.id);
      return {
        again,
        started,
        transcript: yield* transcript(thread.id),
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

  // covers AG-006, CH-008
  it("[TC-CH-010] queues messages for a paused hob, also ones sent while paused, and runs them in order once it wakes", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const lifecycle = yield* HobLifecycle;
      const thread = yield* chat.createThread(HOB_ID);

      yield* chat.sendPrompt(thread.id, "now");
      yield* chat.sendPrompt(thread.id, "after the nap");
      yield* lifecycle.pause(HOB_ID);
      // The running reply finishes; the queued message waits for the hob.
      yield* HobbotsRepository.use((repo) => repo.listMessages(thread.id)).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.status === "streaming") ? Effect.fail("streaming" as const) : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      const sentWhilePaused = yield* chat.sendPrompt(thread.id, "and this");
      yield* Effect.sleep("50 millis");
      const whilePaused = yield* transcript(thread.id);
      const woke = yield* Effect.forkChild(lifecycle.wake(HOB_ID));
      yield* Fiber.join(woke);
      yield* settled(thread.id);
      return { sentWhilePaused, whilePaused, afterWake: yield* transcript(thread.id) };
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
