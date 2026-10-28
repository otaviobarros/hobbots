import { HobbotsRepository, SqliteLive } from "@hobbots/persistence";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Option, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";
import { ALDRIC_ID, seedAgents } from "../src/seed.ts";

const Persistence = HobbotsRepository.layer.pipe(Layer.provideMerge(SqliteLive(":memory:")));
const TestLayer = ChatService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effectDiscard(seedAgents).pipe(Layer.provideMerge(Persistence)),
      EventBus.layer,
      FakeRuntimeLayer(),
    ),
  ),
);

describe("ChatService", () => {
  it("streams a turn, completes it, stores the session id and resumes it on the next prompt", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;

      const thread = yield* chat.createThread(ALDRIC_ID);
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
});
