import {
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeEvent,
  type ToolStartedEvent,
} from "@hobbots/agents";
import { Agent, AgentId, isInProgress, type Message, type ThreadId } from "@hobbots/domain";
import { EventJournal, HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Context, Deferred, Effect, Layer, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

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

const runtime = (sendPrompt: (request: PromptRequest) => Stream.Stream<RuntimeEvent>) =>
  Layer.succeed(
    RuntimeAdapter,
    RuntimeAdapter.of({
      health: Effect.die("unused"),
      models: Effect.die("unused"),
      enforcement: Effect.die("unused"),
      sendPrompt,
    }),
  );

const push: ToolStartedEvent = {
  _tag: "ToolStarted",
  id: "t1",
  tool: "Bash",
  operation: "push",
  targets: ["origin"],
  label: "Running git push",
};

// The first hub records the push as the runtime starts it, then the push runs until the hub dies.
const pushing = runtime((request) =>
  Stream.make<ReadonlyArray<RuntimeEvent>>(
    { _tag: "SessionStarted", sessionId: "s1", billing: "fake" },
    { _tag: "TextDelta", text: "Pushing the fix" },
  ).pipe(
    Stream.concat(
      Stream.fromEffect(request.recordToolStart?.(push) ?? Effect.succeed(false)).pipe(
        Stream.flatMap((recorded) => (recorded ? Stream.never : Stream.die("the push was not recorded"))),
      ),
    ),
  ),
);

const firstHub = ChatService.layer.pipe(
  Layer.provide(HobTools.chatOnly),
  Layer.provideMerge(Layer.mergeAll(EventBus.layer, HobAdmission.layer, pushing)),
  Layer.provideMerge(
    Layer.effectDiscard(summonHob).pipe(
      Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer)),
      Layer.provideMerge(TestDatabase),
    ),
  ),
);

const lastReply = (threadId: ThreadId, check: (reply: Message) => boolean) =>
  Effect.gen(function* () {
    const reply = (yield* (yield* HobbotsRepository).listMessages(threadId)).at(-1);
    return reply?.role === "assistant" && check(reply) ? reply : yield* Effect.fail("not yet" as const);
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }), Effect.orDie);

/**
 * A hub that dies while a push runs, then starts again over the same database with `restart` as its
 * runtime. A new memo map builds new services instead of handing back the dead hub's.
 */
const crashMidPush = (restart: Layer.Layer<RuntimeAdapter>) =>
  Effect.gen(function* () {
    const chat = yield* ChatService;
    const thread = yield* chat.createThread(HOB_ID);
    yield* chat.sendPrompt(thread.id, "Push the fix");
    const running = yield* lastReply(thread.id, (reply) => reply.steps.some((step) => step.state === "running"));
    const restarted = yield* Layer.buildWithMemoMap(
      ChatService.layer.pipe(Layer.provide(HobTools.chatOnly), Layer.provide(Layer.mergeAll(EventBus.layer, restart))),
      yield* Layer.makeMemoMap,
      yield* Effect.scope,
    );
    const recovered = yield* lastReply(thread.id, (reply) => reply.status === "interrupted");
    return { thread, running, recovered, chat: Context.get(restarted, ChatService) };
  });

const completes = (text: string) =>
  Stream.make<ReadonlyArray<RuntimeEvent>>(
    { _tag: "SessionStarted", sessionId: "s1", billing: "fake" },
    { _tag: "Completed", sessionId: "s1", text },
  );

describe("a tool call cut off by a crash", () => {
  // covers EX-004, CH-004, CH-007
  it("[TC-EX-012] is recorded before it runs, comes back uncertain after a restart, and Continue is told to check it instead of running it again", async () => {
    const result = await Effect.gen(function* () {
      const prompts: Array<string> = [];
      const { thread, running, recovered, chat } = yield* crashMidPush(
        runtime((request) => {
          prompts.push(request.prompt);
          return completes(" I checked: the push had landed.");
        }),
      );
      yield* chat.continueReply(thread.id, recovered.id);
      const continued = yield* lastReply(thread.id, (reply) => !isInProgress(reply.status));
      return { running, recovered, continued, prompts };
    }).pipe(Effect.provide(firstHub), Effect.scoped, Effect.runPromise);

    // Saved before it ran, with when it started.
    expect(result.running.steps).toEqual([
      expect.objectContaining({ id: "t1", state: "running", startedAt: expect.any(String) }),
    ]);
    // After the restart its outcome is unknown, and what is known about it is kept.
    expect(result.recovered.steps).toEqual([
      {
        id: "t1",
        kind: "tool",
        label: "Running git push",
        state: "uncertain",
        call: { tool: "Bash", operation: "push", targets: ["origin"] },
        startedAt: result.running.steps[0]?.startedAt,
      },
    ]);
    // Continue names the call and says not to run it again before checking; it never runs again by itself.
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]).toContain("- Running git push (Bash, push on origin)");
    expect(result.prompts[0]).toContain("Do not run any of them again until you have checked whether it took effect");
    expect(result.continued.status).toBe("complete");
    expect(result.continued.steps.map((step) => [step.id, step.state])).toEqual([["t1", "uncertain"]]);
  });

  // covers EX-004, CH-008
  it("[TC-EX-015] tells every turn after the crash about the uncertain call, a queued one and one after a completed reply included", async () => {
    const briefings = await Effect.gen(function* () {
      const told: Array<string | null> = [];
      const release = yield* Deferred.make<void>();
      const { thread, chat } = yield* crashMidPush(
        runtime((request) => {
          told.push(request.briefing ?? null);
          // The first follow-up runs until it is stopped; the next ones complete.
          return told.length === 1
            ? Stream.make<ReadonlyArray<RuntimeEvent>>({
                _tag: "SessionStarted",
                sessionId: "s1",
                billing: "fake",
              }).pipe(Stream.concat(Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain)))
            : completes("Checked.");
        }),
      );
      const settled = (count: number) =>
        Effect.suspend(() => (told.length >= count ? Effect.void : Effect.fail("not yet" as const))).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
          Effect.orDie,
        );
      // A new message on the same brain, and one queued behind it that starts once it is stopped.
      yield* chat.sendPrompt(thread.id, "Did it work?");
      yield* settled(1);
      yield* chat.sendPrompt(thread.id, "And tag the release");
      yield* chat.stop(thread.id);
      yield* settled(2);
      yield* lastReply(thread.id, (reply) => reply.status === "complete");
      // A reply that completes may not have checked it, so the next turn is told again.
      yield* chat.sendPrompt(thread.id, "Thanks");
      yield* settled(3);
      return told;
    }).pipe(Effect.provide(firstHub), Effect.scoped, Effect.runPromise);

    expect(briefings).toHaveLength(3);
    for (const briefing of briefings) {
      expect(briefing).toContain("- Running git push (Bash, push on origin)");
      expect(briefing).toContain("Do not run any of them again until you have checked whether it took effect");
    }
  });
});
