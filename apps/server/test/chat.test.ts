import { Agent, AgentId } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Option, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("aldric");

// New installations start without hobs, so each test summons its own.
const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Aldric",
      role: "Guide",
      runtime: "claude-code",
      model: null,
      instructions: "You are Aldric.",
      lookSeed: 4821,
      lookColor: "violet",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

const Persistence = HobbotsRepository.layer.pipe(Layer.provideMerge(TestDatabase));
const testLayer = (runtime = FakeRuntimeLayer()) =>
  ChatService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(Persistence)), EventBus.layer, runtime),
    ),
  );
const TestLayer = testLayer();

describe("ChatService", () => {
  // covers CH-002, CH-004, DP-003
  it("[TC-CH-001] streams a turn, completes it, stores the session id and resumes it on the next prompt", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;

      const thread = yield* chat.createThread(HOB_ID);
      // Waits until no assistant message in the thread is still streaming.
      const settled = repo.listMessages(thread.id).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.status === "streaming") ? Effect.fail("streaming" as const) : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );

      yield* chat.sendPrompt(thread.id, "hello");
      yield* settled;
      const afterFirst = yield* repo.findThread(thread.id);
      yield* chat.sendPrompt(thread.id, "again");
      yield* settled;

      return {
        messages: yield* repo.listMessages(thread.id),
        threadAfterFirst: afterFirst,
        threadAfterSecond: yield* repo.findThread(thread.id),
      };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "hello", "complete"],
      ["assistant", "Echo: hello", "complete"],
      ["user", "again", "complete"],
      ["assistant", "Echo: again", "complete"],
    ]);
    const firstSession = Option.getOrUndefined(result.threadAfterFirst);
    const secondSession = Option.getOrUndefined(result.threadAfterSecond);
    expect(firstSession?.title).toBe("hello");
    expect(firstSession?.runtimeSessionId).toMatch(/^fake-/);
    expect(secondSession?.runtimeSessionId).toBe(firstSession?.runtimeSessionId);
  });

  // covers EX-005
  it("[TC-EX-001] lists a thread as active while its turn runs and drops it once the turn ends", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const thread = yield* chat.createThread(HOB_ID);

      yield* chat.sendPrompt(thread.id, "hello");
      const during = yield* chat.activeThreads;
      yield* repo.listMessages(thread.id).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.status === "streaming") ? Effect.fail("streaming" as const) : Effect.void,
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      // The turn's fiber leaves the map just after it saves the final message.
      const after = yield* chat.activeThreads.pipe(
        Effect.flatMap((ids) => (ids.length > 0 ? Effect.fail("active" as const) : Effect.succeed(ids))),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      return { threadId: thread.id, during, after };
    }).pipe(Effect.provide(testLayer(FakeRuntimeLayer({ delay: "20 millis" }))), Effect.scoped, Effect.runPromise);

    expect(result.during).toEqual([result.threadId]);
    expect(result.after).toEqual([]);
  });
});
