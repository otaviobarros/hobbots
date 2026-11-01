import { ChatService, HobAdmission, HobbotsRepository, HobLifecycle, HobTools } from "@hobbots/agents";
import { ThreadArchived, ThreadArchiveRefused } from "@hobbots/api";
import { Agent, AgentId, type Message, type Thread, type ThreadId } from "@hobbots/domain";
import { HobbotsRepositoryLive, SearchIndex } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Exit, Layer, Option, Schedule, type Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");

const summonHob = HobbotsRepository.use((repo) =>
  repo.insertAgent(
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
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ),
);

const testLayer = HobLifecycle.layer.pipe(
  Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly))),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effectDiscard(summonHob).pipe(
        Layer.provideMerge(
          Layer.mergeAll(HobbotsRepositoryLive, SearchIndex.layer).pipe(Layer.provideMerge(TestDatabase)),
        ),
      ),
      EventBus.layer,
      HobAdmission.layer,
      // Slow enough that a reply is still running when the thread is archived.
      FakeRuntimeLayer({ delay: "15 millis" }),
    ),
  ),
);

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof testLayer> | Scope.Scope>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

// Waits until the thread has no turn running and nothing streaming or queued.
const settled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const messages = yield* repo.listMessages(threadId);
    const busy = messages.some((m) => m.status === "streaming" || m.status === "queued");
    if (busy || (yield* chat.activeThreads).includes(threadId)) return yield* Effect.fail("busy" as const);
  }).pipe(Effect.retry(Schedule.spaced("5 millis")));

// A thread with one finished turn, as a thread the user is done with looks.
const finishedThread = (prompt = "Plan the kettle repair") =>
  Effect.gen(function* () {
    const chat = yield* ChatService;
    const thread = yield* chat.createThread(HOB_ID);
    yield* chat.sendPrompt(thread.id, prompt);
    yield* settled(thread.id);
    return yield* HobbotsRepository.use((repo) => repo.findThread(thread.id)).pipe(Effect.map(Option.getOrThrow));
  });

// Records the thread events published from here on.
const recordThreadEvents = Effect.gen(function* () {
  const bus = yield* EventBus;
  const threads: Array<Thread> = [];
  yield* bus.stream.pipe(
    Stream.runForEach((published) =>
      Effect.sync(() => {
        if (published._tag === "Journaled" && published.entry.payload._tag === "ThreadUpserted") {
          threads.push(published.entry.payload.thread);
        }
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return threads;
});

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : undefined;

describe("archived threads", () => {
  // covers CH-001, CH-009
  it("[TC-CH-140] archives and restores a thread once each, durably and live, without moving it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const thread = yield* finishedThread();
        const events = yield* recordThreadEvents;

        const archived = yield* chat.archive(thread.id);
        const again = yield* chat.archive(thread.id);
        const lists = {
          live: (yield* repo.listThreads(HOB_ID)).map((t) => t.id),
          archived: (yield* repo.listArchivedThreads(HOB_ID)).map((t) => t.id),
        };
        const restored = yield* chat.restore(thread.id);
        const restoredAgain = yield* chat.restore(thread.id);
        yield* Effect.yieldNow;
        return {
          thread,
          archived,
          again,
          lists,
          restored,
          restoredAgain,
          liveAfter: (yield* repo.listThreads(HOB_ID)).map((t) => t.id),
          archivedAfter: yield* repo.listArchivedThreads(HOB_ID),
          events: events.map((t) => t.archivedAt !== null),
        };
      }),
    );

    expect(result.thread.archivedAt).toBeNull();
    expect(result.archived.archivedAt).not.toBeNull();
    expect(result.archived.updatedAt).toBe(result.thread.updatedAt);
    expect(result.again).toEqual(result.archived);
    expect(result.lists).toEqual({ live: [], archived: [result.thread.id] });
    expect(result.restored.archivedAt).toBeNull();
    expect(result.restored.updatedAt).toBe(result.thread.updatedAt);
    expect(result.restoredAgain).toEqual(result.restored);
    expect(result.liveAfter).toEqual([result.thread.id]);
    expect(result.archivedAfter).toEqual([]);
    // One journaled change each; the repeats change nothing.
    expect(result.events).toEqual([true, false]);
  });

  // covers CH-009
  it("[TC-CH-141] lists a hob's archived threads newest-archived first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const first = yield* finishedThread("first");
        const second = yield* finishedThread("second");
        yield* chat.archive(second.id);
        yield* Effect.sleep("2 millis");
        yield* chat.archive(first.id);
        const archived = yield* HobbotsRepository.use((repo) => repo.listArchivedThreads(HOB_ID));
        return { order: archived.map((t) => t.id), expected: [first.id, second.id] };
      }),
    );
    expect(result.order).toEqual(result.expected);
  });

  // covers CH-008, CH-009
  it("[TC-CH-142] refuses to archive while a reply runs or a message waits, then archives once it ends", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const lifecycle = yield* HobLifecycle;
        const thread = yield* chat.createThread(HOB_ID);

        yield* chat.sendPrompt(thread.id, "one");
        const running = yield* Effect.exit(chat.archive(thread.id));
        yield* settled(thread.id);

        // A paused hob keeps the message waiting in the queue.
        yield* lifecycle.pause(HOB_ID);
        yield* chat.sendPrompt(thread.id, "two");
        const queued = yield* Effect.exit(chat.archive(thread.id));
        yield* lifecycle.wake(HOB_ID);
        yield* settled(thread.id);

        const archived = yield* chat.archive(thread.id);
        return { running: refusal(running), queued: refusal(queued), archived };
      }),
    );
    expect(result.running).toEqual(new ThreadArchiveRefused({ threadId: result.archived.id, reason: "reply-running" }));
    expect(result.queued).toEqual(new ThreadArchiveRefused({ threadId: result.archived.id, reason: "reply-running" }));
    expect(result.archived.archivedAt).not.toBeNull();
  });

  // covers CH-009
  it("[TC-CH-143] takes no new message, Continue or brain switch in an archived thread until it is restored", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const thread = yield* finishedThread();
        const archived = yield* chat.archive(thread.id);
        const reply = (yield* repo.listMessages(thread.id)).at(-1) as Message;
        const sent = yield* Effect.exit(chat.sendPrompt(thread.id, "more"));
        const continued = yield* Effect.exit(chat.continueReply(thread.id, reply.id));
        const switched = yield* Effect.exit(
          chat.setBrain(thread.id, { runtime: "claude-code", model: "fable", effort: null }),
        );
        const before = (yield* repo.listMessages(thread.id)).length;
        yield* chat.restore(thread.id);
        yield* chat.sendPrompt(thread.id, "more");
        yield* settled(thread.id);
        return {
          archived,
          refusals: [sent, continued, switched].map(refusal),
          before,
          after: (yield* repo.listMessages(thread.id)).length,
        };
      }),
    );
    const expected = new ThreadArchived({ threadId: result.archived.id, archivedAt: result.archived.archivedAt ?? "" });
    expect(result.refusals).toEqual([expected, expected, expected]);
    expect(result.before).toBe(2);
    expect(result.after).toBe(4);
  });

  // covers AG-006, CH-009
  it("[TC-CH-144] keeps a retired hob's archived threads as they are, and refuses to archive or restore them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const lifecycle = yield* HobLifecycle;
        const archived = yield* chat.archive((yield* finishedThread("old")).id);
        const live = yield* finishedThread("current");
        yield* lifecycle.retire(HOB_ID, "finish");
        const repo = yield* HobbotsRepository;
        return {
          archived,
          stored: yield* repo.findThread(archived.id),
          liveIds: (yield* repo.listThreads(HOB_ID)).map((t) => t.id),
          live,
          restore: refusal(yield* Effect.exit(chat.restore(archived.id))),
          archive: refusal(yield* Effect.exit(chat.archive(live.id))),
          archivedAgain: yield* chat.archive(archived.id),
        };
      }),
    );
    expect(Option.getOrNull(result.stored)).toEqual(result.archived);
    expect(result.liveIds).toEqual([result.live.id]);
    expect(result.restore).toEqual(new ThreadArchiveRefused({ threadId: result.archived.id, reason: "hob-retired" }));
    expect(result.archive).toEqual(new ThreadArchiveRefused({ threadId: result.live.id, reason: "hob-retired" }));
    expect(result.archivedAgain).toEqual(result.archived);
  });

  // covers CH-006, CH-009
  it("[TC-CH-145] still finds an archived thread by search, marked archived", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const archived = yield* chat.archive((yield* finishedThread("Plan the kettle repair")).id);
        const hits = yield* SearchIndex.use((index) => index.search("kettle"));
        return { archived, hits: hits.map((hit) => [hit.thread.id, hit.thread.archivedAt]) };
      }),
    );
    expect(result.hits).toEqual([[result.archived.id, result.archived.archivedAt]]);
  });
});
