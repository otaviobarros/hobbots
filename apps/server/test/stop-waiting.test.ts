import {
  ChatService,
  EventPublisher,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeEvent,
} from "@hobbots/agents";
import { Agent, AgentId, type Message, type MessageId, type ThreadId } from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer, Schedule, Stream } from "effect";
import { describe, expect, it } from "vitest";

// Issue #1056: once a hob has answered and its reply only waits on a command it started, Stop
// waiting ends the reply with its text, and the command shows as stopped by you.

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

const devServer: RuntimeEvent = {
  _tag: "ToolStarted",
  id: "c1",
  tool: "Bash",
  operation: "run-commands",
  targets: ["/work"],
  label: "Running pnpm dev",
};

/**
 * A runtime that starts `pnpm dev`, answers, and then waits on the command, which never ends: or,
 * for a prompt that says "busy", writes and keeps writing, so it never waits. It keeps each request.
 */
const makeWaitingRuntime = (requests: Array<PromptRequest>) =>
  Layer.succeed(
    RuntimeAdapter,
    RuntimeAdapter.of({
      health: Effect.die("unused"),
      models: Effect.die("unused"),
      enforcement: Effect.die("unused"),
      sendPrompt: (request) => {
        requests.push(request);
        const started: RuntimeEvent = { _tag: "SessionStarted", sessionId: "s1", billing: "fake" };
        if (request.prompt === "next") {
          return Stream.fromIterable<RuntimeEvent>([
            started,
            { _tag: "TextDelta", text: "Fine." },
            { _tag: "Completed", sessionId: "s1", text: "Fine." },
          ]);
        }
        const busy = request.prompt === "busy";
        return Stream.fromIterable<RuntimeEvent>([
          started,
          ...(busy ? [] : [devServer]),
          { _tag: "TextDelta", text: "Started the dev server." },
          ...(busy ? [] : [{ _tag: "AwaitingCommands", ids: ["c1"] } as const]),
        ]).pipe(Stream.concat(Stream.never));
      },
    }),
  );

type Services = ChatService | HobbotsRepository;

const run = <A, E>(test: (requests: ReadonlyArray<PromptRequest>) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const requests: Array<PromptRequest> = [];
    const bus = Layer.succeed(EventPublisher, {
      publish: () => Effect.void,
      publishTransient: () => Effect.void,
    });
    const layer = ChatService.layer
      .pipe(Layer.provide(HobTools.chatOnly))
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(HobbotsRepositoryLive), Layer.provide(TestDatabase)),
            bus,
            HobAdmission.layer,
            makeWaitingRuntime(requests),
          ),
        ),
      );
    return yield* test(requests).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.runPromise);

const reply = (threadId: ThreadId, messageId: MessageId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    return (yield* repo.listMessages(threadId)).find((m) => m.id === messageId);
  });

const until = (threadId: ThreadId, messageId: MessageId, ready: (message: Message) => boolean) =>
  reply(threadId, messageId).pipe(
    Effect.flatMap((m) => (m !== undefined && ready(m) ? Effect.succeed(m) : Effect.fail("not yet" as const))),
    Effect.retry(Schedule.spaced("5 millis")),
  );

describe("Stop waiting (#1056)", () => {
  // covers CH-004, CH-007
  it("[TC-CH-1056-01] ends a reply that waits on a command with its text, and tells the next turn the command was stopped", async () => {
    const result = await run((requests) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const thread = yield* chat.createThread(HOB_ID);
        const { assistantMessage } = yield* chat.sendPrompt(thread.id, "start the dev server");
        if (assistantMessage === null) return yield* Effect.die("the first message did not start");
        const waiting = yield* until(thread.id, assistantMessage.id, (m) =>
          m.steps.some((step) => step.waitedOn === true),
        );
        yield* chat.stopWaiting(thread.id);
        const ended = yield* until(thread.id, assistantMessage.id, (m) => m.status === "complete");
        yield* chat.sendPrompt(thread.id, "next");
        yield* Effect.suspend(() => (requests.length === 2 ? Effect.void : Effect.fail("not yet" as const))).pipe(
          Effect.retry(Schedule.spaced("5 millis")),
        );
        return { waiting, ended, next: requests[1] };
      }),
    );

    expect(result.waiting.status).toBe("streaming");
    expect(result.waiting.steps).toEqual([expect.objectContaining({ id: "c1", state: "running", waitedOn: true })]);
    expect(result.ended.content).toBe("Started the dev server.");
    expect(result.ended.error).toBeNull();
    const [stopped] = result.ended.steps;
    expect(stopped).toMatchObject({ id: "c1", state: "stopped" });
    expect(stopped?.endedAt).toEqual(expect.any(String));
    expect(stopped?.waitedOn).toBeUndefined();
    expect(result.next?.briefing).toContain("the user stopped these commands");
    expect(result.next?.briefing).toContain("- Running pnpm dev");
  });

  // covers CH-007
  it("[TC-CH-1056-02] changes nothing while the hob is still at work, so Stop stays the way to end it", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const idle = yield* chat.createThread(HOB_ID);
        yield* chat.stopWaiting(idle.id);
        const thread = yield* chat.createThread(HOB_ID);
        const { assistantMessage } = yield* chat.sendPrompt(thread.id, "busy");
        if (assistantMessage === null) return yield* Effect.die("the first message did not start");
        yield* until(thread.id, assistantMessage.id, (m) => m.content.length > 0);
        yield* chat.stopWaiting(thread.id);
        yield* Effect.sleep("30 millis");
        const after = yield* reply(thread.id, assistantMessage.id);
        yield* chat.stop(thread.id);
        const stopped = yield* until(thread.id, assistantMessage.id, (m) => m.status === "stopped");
        return { after, stopped };
      }),
    );

    expect(result.after?.status).toBe("streaming");
    expect(result.stopped.content).toBe("Started the dev server.");
  });
});
