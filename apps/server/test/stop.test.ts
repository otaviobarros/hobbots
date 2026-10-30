import { Agent, AgentId, type HobbotsEvent, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer, RuntimeAdapter, type RuntimeEvent } from "@hobbots/runtimes";
import { Deferred, Effect, Layer, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { HobAdmission } from "../src/admission.ts";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("wren");
const NOW = "2026-01-01T00:00:00.000Z";

const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Wren",
      roleTitle: "Writer",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 7,
      lookColor: "moss",
      configVersion: 1,
      createdAt: NOW,
    }),
  );
});

/**
 * A runtime that writes "Partial" and then waits. When the turn is cancelled it holds its shutdown
 * until the test confirms, standing in for a runtime that takes a moment to end the turn.
 */
const makeSlowRuntime = (confirm: Deferred.Deferred<void>) =>
  Layer.succeed(
    RuntimeAdapter,
    RuntimeAdapter.of({
      health: Effect.die("unused"),
      models: Effect.die("unused"),
      sendPrompt: () =>
        Stream.fromIterable<RuntimeEvent>([
          { _tag: "SessionStarted", sessionId: "slow", billing: "fake" },
          { _tag: "TextDelta", text: "Partial" },
        ]).pipe(Stream.concat(Stream.never), Stream.ensuring(Deferred.await(confirm))),
    }),
  );

const run = <A, E>(
  test: (events: Array<HobbotsEvent>, confirm: Deferred.Deferred<void>) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const confirm = yield* Deferred.make<void>();
    const events: Array<HobbotsEvent> = [];
    const bus = Layer.succeed(EventBus, {
      publish: (entries) => Effect.sync(() => void events.push(...entries.map((entry) => entry.payload))),
      publishTransient: (event) => Effect.sync(() => void events.push(event)),
      stream: Stream.empty,
    });
    const layer = ChatService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(HobbotsRepository.layer), Layer.provide(TestDatabase)),
          bus,
          HobAdmission.layer,
          makeSlowRuntime(confirm),
        ),
      ),
    );
    return yield* test(events, confirm).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.runPromise);

type Services = ChatService | HobbotsRepository;

const statusOf = (threadId: ThreadId, messageId: MessageId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    return (yield* repo.listMessages(threadId)).find((m) => m.id === messageId);
  });

const waitFor = (threadId: ThreadId, messageId: MessageId, status: Message["status"]) =>
  statusOf(threadId, messageId).pipe(
    Effect.flatMap((m) => (m?.status === status ? Effect.succeed(m) : Effect.fail("not yet" as const))),
    Effect.retry(Schedule.spaced("5 millis")),
  );

const stopEvents = (events: ReadonlyArray<HobbotsEvent>) =>
  events.flatMap((e) =>
    e._tag === "TurnStopRequested" || e._tag === "TurnStopped"
      ? [e._tag]
      : e._tag === "MessageUpserted" && e.message.role === "assistant"
        ? [`MessageUpserted:${e.message.status}`]
        : [],
  );

describe("Stopping a reply", () => {
  // covers CH-007
  it("[TC-CH-002] shows stopping until the runtime confirms, then stopped with the partial text kept", async () => {
    const result = await run((events, confirm) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const thread = yield* chat.createThread(HOB_ID);
        const { assistantMessage } = yield* chat.sendPrompt(thread.id, "write a poem");
        if (assistantMessage === null) return yield* Effect.die("the first message did not start");
        // The partial text is on the reply before Stop is pressed.
        yield* Effect.retry(
          Effect.suspend(() =>
            events.some((e) => e._tag === "MessageDelta") ? Effect.void : Effect.fail("no text" as const),
          ),
          Schedule.spaced("5 millis"),
        );

        yield* chat.stop(thread.id);
        const requested = yield* statusOf(thread.id, assistantMessage.id);
        const busyWhileStopping = yield* chat.activeThreads;

        yield* Deferred.succeed(confirm, undefined);
        const stopped = yield* waitFor(thread.id, assistantMessage.id, "stopped");

        // The thread and hob take the next message as usual: it starts right away, or just after
        // the stopped turn has left the thread.
        yield* chat.sendPrompt(thread.id, "again");
        const next = yield* HobbotsRepository.use((repo) => repo.listMessages(thread.id)).pipe(
          Effect.flatMap((messages) => {
            const last = messages.at(-1);
            return last?.role === "assistant" && last.status === "streaming"
              ? Effect.succeed(last)
              : Effect.fail("not yet" as const);
          }),
          Effect.retry(Schedule.spaced("5 millis")),
        );
        return { requested, busyWhileStopping, stopped, events: stopEvents(events), next, threadId: thread.id };
      }),
    );

    expect(result.requested?.status).toBe("stopping");
    expect(result.busyWhileStopping).toEqual([result.threadId]);
    expect(result.stopped).toMatchObject({ status: "stopped", content: "Partial", error: null });
    expect(result.events).toEqual([
      "MessageUpserted:streaming",
      "MessageUpserted:stopping",
      "TurnStopRequested",
      "MessageUpserted:stopped",
      "TurnStopped",
      "MessageUpserted:streaming",
    ]);
    expect(result.next.status).toBe("streaming");
  });

  // covers CH-007
  it("[TC-CH-003] treats repeated stops, and stops with no reply running, as harmless", async () => {
    const result = await run((events, confirm) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const idle = yield* chat.createThread(HOB_ID);
        yield* chat.stop(idle.id);

        const thread = yield* chat.createThread(HOB_ID);
        const { assistantMessage } = yield* chat.sendPrompt(thread.id, "write a poem");
        if (assistantMessage === null) return yield* Effect.die("the first message did not start");
        yield* Effect.all([chat.stop(thread.id), chat.stop(thread.id), chat.stop(thread.id)], {
          concurrency: "unbounded",
        });
        yield* Deferred.succeed(confirm, undefined);
        const stopped = yield* waitFor(thread.id, assistantMessage.id, "stopped");
        yield* chat.stop(thread.id);
        return { stopped, events: stopEvents(events), after: yield* statusOf(thread.id, assistantMessage.id) };
      }),
    );

    expect(result.events).toEqual([
      "MessageUpserted:streaming",
      "MessageUpserted:stopping",
      "TurnStopRequested",
      "MessageUpserted:stopped",
      "TurnStopped",
    ]);
    expect(result.after?.status).toBe("stopped");
  });

  // covers CH-007, DP-003
  it("[TC-CH-004] on restart, a reply left stopping is stopped and one left streaming is interrupted", async () => {
    const threadId = ThreadId.make("t1");
    const reply = (id: string, status: Message["status"]) =>
      new Message({
        id: MessageId.make(id),
        threadId,
        role: "assistant",
        content: id,
        status,
        error: null,
        configVersion: 1,
        createdAt: NOW,
      });

    const result = await Effect.gen(function* () {
      const events: Array<HobbotsEvent> = [];
      const repo = yield* HobbotsRepository;
      yield* repo.upsertThread(
        new Thread({
          id: threadId,
          agentId: HOB_ID,
          title: "t",
          runtimeSessionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      yield* repo.upsertMessage(reply("a", "stopping"));
      yield* repo.upsertMessage(reply("b", "streaming"));
      yield* repo.upsertMessage(reply("c", "complete"));

      // The hub starts again over the same database.
      yield* Layer.build(
        ChatService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EventBus, {
                publish: (entries) => Effect.sync(() => void events.push(...entries.map((entry) => entry.payload))),
                publishTransient: (event) => Effect.sync(() => void events.push(event)),
                stream: Stream.empty,
              }),
              HobAdmission.layer,
              FakeRuntimeLayer(),
            ),
          ),
        ),
      );
      return { messages: yield* repo.listMessages(threadId), events: stopEvents(events) };
    }).pipe(
      Effect.provide(
        Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(HobbotsRepository.layer), Layer.provide(TestDatabase)),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(result.messages.map((m) => [m.id, m.content, m.status])).toEqual([
      ["a", "a", "stopped"],
      ["b", "b", "interrupted"],
      ["c", "c", "complete"],
    ]);
    expect(result.events).toEqual(["MessageUpserted:stopped", "TurnStopped", "MessageUpserted:interrupted"]);
  });
});
