import { Agent, AgentId, isInProgress, type MessageId, type ThreadId } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FAKE_DIRECTIVES, FakeRuntimeLayer, fakeCutOffError } from "@hobbots/runtimes";
import { Effect, Layer, Option, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { HobAdmission } from "../src/admission.ts";
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
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "You are Aldric.",
      lookSeed: 4821,
      lookColor: "violet",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

const Persistence = HobbotsRepository.layer.pipe(Layer.provideMerge(TestDatabase));
const testLayer = (runtime = FakeRuntimeLayer()) =>
  ChatService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(Persistence)),
        EventBus.layer,
        HobAdmission.layer,
        runtime,
      ),
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
      // Waits until no message in the thread is still streaming or queued.
      const settled = repo.listMessages(thread.id).pipe(
        Effect.flatMap((messages) =>
          // A started message is saved a moment before its reply, so wait for the reply too.
          messages.some((m) => m.status === "streaming" || m.status === "queued") ||
          messages.at(-1)?.role !== "assistant"
            ? Effect.fail("busy" as const)
            : Effect.void,
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

describe("a reply that ends early", () => {
  /** Waits until the thread's latest reply has ended, however it ended, and nothing waits behind it. */
  const settled = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const messages = yield* repo.listMessages(threadId);
      const reply = messages.at(-1);
      return reply?.role !== "assistant" || isInProgress(reply.status) || messages.some((m) => m.status === "queued")
        ? yield* Effect.fail("busy" as const)
        : reply;
    }).pipe(Effect.retry(Schedule.spaced("5 millis")));
  const replyTo = (threadId: ThreadId, prompt: string) =>
    Effect.gen(function* () {
      yield* (yield* ChatService).sendPrompt(threadId, prompt);
      return yield* settled(threadId);
    });
  // A reply is saved as ended a moment before its turn lets go of the thread.
  const continueSoon = (threadId: ThreadId, messageId: MessageId) =>
    Effect.gen(function* () {
      return yield* (yield* ChatService).continueReply(threadId, messageId);
    }).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 100 }));

  // covers CH-004, CH-007
  it("[TC-CH-098] keeps a cut-off reply with its reason, and Continue resumes it in the same message", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      const cut = yield* replyTo(thread.id, `${FAKE_DIRECTIVES.cutOff} please`);
      const resumed = yield* continueSoon(thread.id, cut.id);
      const finished = yield* settled(thread.id);
      const again = yield* chat.continueReply(thread.id, cut.id).pipe(Effect.flip);
      return { cut, resumed, finished, again };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.cut).toMatchObject({ status: "interrupted", error: fakeCutOffError });
    expect(result.resumed).toMatchObject({ id: result.cut.id, status: "streaming", error: null });
    expect(result.finished.status).toBe("complete");
    expect(result.finished.content.startsWith(result.cut.content)).toBe(true);
    expect(result.finished.content.length).toBeGreaterThan(result.cut.content.length);
    // A finished reply cannot be continued.
    expect(result.again._tag).toBe("ReplyNotResumable");
  });

  // covers CH-004, AG-004
  it("[TC-CH-101] stores the configuration a continued reply runs on, after the hob was edited", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const thread = yield* chat.createThread(HOB_ID);
      const cut = yield* replyTo(thread.id, `${FAKE_DIRECTIVES.cutOff} please`);
      const hob = Option.getOrThrow(yield* repo.findAgent(HOB_ID));
      yield* repo.updateAgentConfig(
        new Agent({ ...hob, instructions: "Be brief.", configVersion: hob.configVersion + 1 }),
      );
      const resumed = yield* continueSoon(thread.id, cut.id);
      yield* settled(thread.id);
      const stored = (yield* repo.listMessages(thread.id)).find((m) => m.id === cut.id);
      return { cut, resumed, stored };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.cut.configVersion).toBe(1);
    expect(result.resumed.configVersion).toBe(2);
    expect(result.stored?.configVersion).toBe(2);
  });

  // covers CH-004
  it("[TC-CH-099] marks a reply the provider limit ended with when the allowance refills", async () => {
    const limited = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      return yield* replyTo(thread.id, `${FAKE_DIRECTIVES.limit} please`);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(limited.status).toBe("limited");
    expect(limited.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(limited.content.length).toBeGreaterThan(0);
  });

  // covers CH-004
  it("[TC-CH-100] continues only the thread's latest reply", async () => {
    const error = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const thread = yield* chat.createThread(HOB_ID);
      const cut = yield* replyTo(thread.id, `${FAKE_DIRECTIVES.cutOff} please`);
      yield* replyTo(thread.id, "next");
      return yield* chat.continueReply(thread.id, cut.id).pipe(Effect.flip);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);
    expect(error._tag).toBe("ReplyNotResumable");
  });
});
