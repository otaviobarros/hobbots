import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  EventPublisher,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
  RuntimeAdapter,
  type RuntimeEvent,
} from "@hobbots/agents";
import { type Agent, AgentId, Agent as HobRecord, type Message, roleFields, type ThreadId } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { type Cause, Deferred, Effect, Layer, Queue, Schedule, Stream } from "effect";
import { type Event, makeParser } from "effect/encoding/Sse";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { EventStream, EventStreamRoute } from "../src/event-stream.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";

const hob = {
  name: "Wren",
  ...roleFields("writer"),
  lookSeed: 7,
  lookColor: "moss",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
};

let turn: Queue.Queue<RuntimeEvent, Cause.Done>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(() => {
  // A runtime the test drives: the turn streams what the test offers, and its process exits only
  // when the test ends the queue, however long after the reply completed.
  turn = Effect.runSync(Queue.unbounded<RuntimeEvent, Cause.Done>());
  const runtime = Layer.succeed(RuntimeAdapter, { ...makeFakeRuntime(), sendPrompt: () => Stream.fromQueue(turn) });
  const App = Layer.mergeAll(HobLifecycle.layer, EventStream.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
        ApprovalService.layer,
        GrantService.layer,
        HobService.layer,
        PermissionSummary.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ApprovalRepositoryLive,
          GrantRepositoryLive,
          TaskRepositoryLive,
          EventJournal.layer,
          BackpackLive,
          SetupRepository.layer,
          SearchIndex.layer,
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        runtime,
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/tmp" }),
      ),
    ),
  );
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(ApiRoutes, EventStreamRoute).pipe(
      Layer.provideMerge(App),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});

afterEach(() => dispose());

const request = async (method: string, path: string, body?: unknown) => {
  const response = await handler(
    new Request(`http://localhost:4381${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const activity = async (): Promise<ReadonlyArray<string>> =>
  (await request("GET", "/api/activity")).body.working.map((hob: { threadId: string }) => hob.threadId);

const waitUntil = (check: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.promise(check).pipe(
      Effect.flatMap((done) => (done ? Effect.void : Effect.fail("not yet" as const))),
      Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
    ),
  );

interface TurnRead {
  readonly event: string;
  readonly threadId: string;
  readonly working: ReadonlyArray<string>;
}

/**
 * Follows `/api/events` as a client does, reading `/api/activity` as soon as each `turn` frame
 * arrives and before the next frame is read.
 */
const followTurns = async () => {
  const response = await handler(new Request("http://localhost:4381/api/events"));
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const reads: Array<TurnRead> = [];
  let turns: Array<Event> = [];
  const parser = makeParser((event) => {
    if (event._tag === "Event" && event.event === "turn") turns.push(event);
  });
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
      const arrived = turns;
      turns = [];
      for (const turn of arrived) {
        const data = JSON.parse(turn.data);
        reads.push({ event: data._tag, threadId: data.threadId, working: await activity() });
      }
    }
  };
  const pumping = pump().catch(() => undefined);
  return { reads, stop: () => reader.cancel().then(() => pumping) };
};

describe("turn events", () => {
  // covers DP-002, UX-001
  it("[TC-DP-054] a read of /api/activity made on each turn event already agrees with it, even while the runtime is slow to exit", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const follower = await followTurns();

    await request("POST", `/api/threads/${thread.id}/messages`, { content: "hello" });
    await waitUntil(async () => follower.reads.length > 0);
    Effect.runSync(
      Queue.offerAll(turn, [
        { _tag: "SessionStarted", sessionId: "s1", billing: "fake" },
        { _tag: "Completed", sessionId: "s1", text: "Hello" },
      ]),
    );
    await waitUntil(async () => {
      const list: ReadonlyArray<Message> = (await request("GET", `/api/threads/${thread.id}/messages`)).body;
      return list.some((m) => m.role === "assistant" && m.status === "complete");
    });
    // The reply completed, but the runtime has not exited: the turn still runs and has not ended.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await activity()).toEqual([thread.id]);
    expect(follower.reads.map((read) => read.event)).toEqual(["TurnStarted"]);

    Effect.runSync(Queue.end(turn));
    await waitUntil(async () => follower.reads.length > 1);
    await follower.stop();

    expect(follower.reads).toEqual([
      { event: "TurnStarted", threadId: thread.id, working: [thread.id] },
      { event: "TurnEnded", threadId: thread.id, working: [] },
    ]);
  });
});

/**
 * A hub whose publisher reads the running turns at the moment it publishes each turn event, and a
 * runtime that writes a little, then waits, and holds its shutdown until the test lets it go.
 */
const atPublish = <A, E>(
  test: (seen: Array<TurnRead>, exit: Deferred.Deferred<void>) => Effect.Effect<A, E, ChatService>,
) =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<void>();
    const seen: Array<TurnRead> = [];
    let chat: ChatService["Service"] | undefined;
    const bus = Layer.succeed(EventPublisher, {
      publish: () => Effect.void,
      publishTransient: (event) =>
        event._tag === "TurnStarted" || event._tag === "TurnEnded"
          ? Effect.suspend(() => chat?.activeThreads ?? Effect.succeed([])).pipe(
              Effect.flatMap((working) =>
                Effect.sync(() => seen.push({ event: event._tag, threadId: event.threadId, working })),
              ),
              Effect.asVoid,
            )
          : Effect.void,
    });
    const runtime = Layer.succeed(RuntimeAdapter, {
      ...makeFakeRuntime(),
      sendPrompt: () =>
        Stream.fromIterable<RuntimeEvent>([
          { _tag: "SessionStarted", sessionId: "slow", billing: "fake" },
          { _tag: "TextDelta", text: "Partial" },
        ]).pipe(Stream.concat(Stream.never), Stream.ensuring(Deferred.await(exit))),
    });
    const summon = HobbotsRepository.use((repo) =>
      repo.insertAgent(
        new HobRecord({
          id: AgentId.make("wren"),
          name: "Wren",
          roleTitle: "Writer",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 7,
          lookColor: "moss",
          configVersion: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    const layer = ChatService.layer.pipe(
      Layer.provide(HobTools.chatOnly),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.effectDiscard(summon).pipe(Layer.provideMerge(HobbotsRepositoryLive), Layer.provide(TestDatabase)),
          bus,
          HobAdmission.layer,
          runtime,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      chat = yield* ChatService;
      return yield* test(seen, exit);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.runPromise);

const until = (check: () => boolean) =>
  Effect.suspend(() => (check() ? Effect.void : Effect.fail("not yet" as const))).pipe(
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
    Effect.orDie,
  );

describe("turn events at the moment they are published", () => {
  // covers DP-002, UX-001
  it("[TC-DP-055] a stopped turn is announced ended only once its runtime has finished shutting down", async () => {
    const result = await atPublish((seen, exit) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const thread = yield* chat.createThread(AgentId.make("wren"));
        yield* chat.sendPrompt(thread.id, "write a poem");
        yield* until(() => seen.length === 1);
        yield* chat.stop(thread.id);
        // The runtime holds its shutdown: the turn still runs, and its end is not announced.
        yield* Effect.sleep("50 millis");
        const whileExiting = { running: yield* chat.activeThreads, announced: seen.length };
        yield* Deferred.succeed(exit, undefined);
        yield* until(() => seen.length === 2);
        return { threadId: thread.id as ThreadId, whileExiting, seen };
      }),
    );

    expect(result.whileExiting).toEqual({ running: [result.threadId], announced: 1 });
    expect(result.seen).toEqual([
      { event: "TurnStarted", threadId: result.threadId, working: [result.threadId] },
      { event: "TurnEnded", threadId: result.threadId, working: [] },
    ]);
  });
});
