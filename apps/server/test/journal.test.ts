import { Agent, AgentId } from "@hobbots/domain";
import { EventJournal, HobbotsRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { RuntimeAdapter, type RuntimeEvent } from "@hobbots/runtimes";
import { Context, Effect, Layer, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { HobAdmission } from "../src/admission.ts";
import { ChatService } from "../src/chat.ts";
import { type BusEvent, EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("odo");

const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Odo",
      roleTitle: "Scribe",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 3,
      lookColor: "moss",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

// Writes "Partial" and then never finishes, like a turn cut off by a crash.
const HangingRuntime = Layer.succeed(
  RuntimeAdapter,
  RuntimeAdapter.of({
    health: Effect.die("unused"),
    models: Effect.die("unused"),
    sendPrompt: () =>
      Stream.fromIterable<RuntimeEvent>([
        { _tag: "SessionStarted", sessionId: "hanging", billing: "fake" },
        { _tag: "TextDelta", text: "Partial" },
      ]).pipe(Stream.concat(Stream.never)),
  }),
);

// A hub process: its own bus and chat service over the shared database.
const hub = ChatService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EventBus.layer, HobAdmission.layer, HangingRuntime)),
);

describe("event journal", () => {
  // covers DP-003, CH-002
  it("[TC-DP-031] publishes committed journal entries, checkpoints streamed text unjournaled, and journals recovery after a crash", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const journal = yield* EventJournal;
      const first = yield* Layer.build(hub);
      const published: Array<BusEvent> = [];
      yield* Stream.runForEach(Context.get(first, EventBus).stream, (event) =>
        Effect.sync(() => void published.push(event)),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const chat = Context.get(first, ChatService);
      const thread = yield* chat.createThread(HOB_ID);
      const { assistantMessage } = yield* chat.sendPrompt(thread.id, "hello");
      const replyId = assistantMessage?.id;
      // The text reaches the row within about a second while the reply still streams.
      const checkpointed = yield* repo.listMessages(thread.id).pipe(
        Effect.flatMap((messages) => {
          const reply = messages.find((m) => m.id === replyId);
          return reply?.content === "Partial" ? Effect.succeed(reply) : Effect.fail("not yet" as const);
        }),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 60 }),
      );
      const beforeCrash = yield* journal.readAfter(0);

      // The process dies without ending the turn; the next one recovers the reply on boot.
      yield* Layer.build(Layer.fresh(hub));
      const recovered = (yield* repo.listMessages(thread.id)).find((m) => m.id === replyId);
      const afterBoot = yield* journal.readAfter(beforeCrash.at(-1)?.sequence ?? 0);
      return { published, beforeCrash, checkpointed, recovered, afterBoot, assistantMessage };
    }).pipe(
      Effect.provide(
        Layer.effectDiscard(summonHob).pipe(
          Layer.provideMerge(Layer.mergeAll(HobbotsRepository.layer, EventJournal.layer)),
          Layer.provideMerge(TestDatabase),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

    // The bus carries exactly the committed entries, then the transient chunk.
    const journaled = result.published.flatMap((e) => (e._tag === "Journaled" ? [e.entry] : []));
    expect(journaled).toEqual(result.beforeCrash.filter((e) => e.sequence > 1));
    expect(
      result.published.flatMap((e) =>
        e._tag === "Transient" && e.event._tag === "MessageDelta" ? [e.event.delta] : [],
      ),
    ).toEqual(["Partial"]);
    // The checkpoint kept the reply streaming at the revision of its last journaled change.
    expect(result.checkpointed.status).toBe("streaming");
    expect(result.checkpointed.revision).toBe(result.assistantMessage?.revision);
    expect(
      result.beforeCrash.filter(
        (e) => e.type === "MessageUpserted" && e.correlation.messageId === result.checkpointed.id,
      ),
    ).toHaveLength(1);
    // Recovery marks it interrupted through a journaled write that keeps the checkpointed text.
    expect([result.recovered?.status, result.recovered?.content]).toEqual(["interrupted", "Partial"]);
    expect(result.afterBoot.map((e) => [e.type, e.correlation.messageId])).toEqual([
      ["MessageUpserted", result.checkpointed.id],
    ]);
    expect(result.recovered?.revision).toBe(result.afterBoot[0]?.sequence);
  });
});
