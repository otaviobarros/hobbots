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
  ChannelMemberRepository,
} from "@hobbots/agents";
import {
  type Agent,
  AgentId,
  Agent as HobRecord,
  hobActor,
  type Message,
  OWNER_ACTOR,
  roleFields,
  Channel,
  ChannelId,
} from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  ChannelMemberRepositoryLive,
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
import { AS_WINDOW, TestDevices } from "./window-device.ts";

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

const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const CAMP = ChannelId.make("camp");

/** Quill's camp, which Pip joined. */
const CampSeed = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const at = "2026-11-14T10:00:00.000Z";
    for (const [id, name] of [
      [QUILL, "Quill"],
      [PIP, "Pip"],
    ] as const) {
      yield* repo.insertAgent(
        new HobRecord({
          id,
          name,
          roleTitle: "Guide",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 3,
          lookColor: "moss",
          configVersion: 1,
          createdAt: at,
        }),
      );
    }
    yield* repo.upsertChannel(
      new Channel({ id: CAMP, ownerHobId: QUILL, title: "Plans", kind: "camp", createdAt: at, updatedAt: at }),
    );
    yield* Effect.orDie((yield* ChannelMemberRepository).add(CAMP, hobActor(PIP), OWNER_ACTOR));
  }),
);

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
        CampSeed.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ChannelMemberRepositoryLive,
              HobbotsRepositoryLive,
              ApprovalRepositoryLive,
              GrantRepositoryLive,
              TaskRepositoryLive,
              EventJournal.layer,
              BackpackLive,
              SetupRepository.layer,
              SearchIndex.layer,
            ),
          ),
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
      Layer.provideMerge(TestDevices),
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
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const activity = async (): Promise<ReadonlyArray<string>> =>
  (await request("GET", "/api/activity")).body.working.map((hob: { channelId: string }) => hob.channelId);

const waitUntil = (check: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.promise(check).pipe(
      Effect.flatMap((done) => (done ? Effect.void : Effect.fail("not yet" as const))),
      Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
    ),
  );

interface TurnRead {
  readonly event: string;
  readonly channelId: string;
  readonly working: ReadonlyArray<string>;
}

/**
 * Follows `/api/events` as a client does, reading `/api/activity` as soon as each `turn` frame
 * arrives and before the next frame is read.
 */
const followTurns = async () => {
  const response = await handler(new Request("http://localhost:4381/api/events", { headers: AS_WINDOW }));
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
        reads.push({ event: data._tag, channelId: data.channelId, working: await activity() });
      }
    }
  };
  const pumping = pump().catch(() => undefined);
  return { reads, stop: () => reader.cancel().then(() => pumping) };
};

describe("turn events", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("names the member hob speaking in a camp as the one working (#1461)", async () => {
    await request("POST", `/api/channels/${CAMP}/messages`, { content: "@pip what do you think?" });
    await waitUntil(async () => (await activity()).length > 0);
    const { working } = (await request("GET", "/api/activity")).body;
    expect(working).toEqual([{ agentId: PIP, name: "Pip", channelId: CAMP }]);
    Effect.runSync(Queue.end(turn));
    await waitUntil(async () => (await activity()).length === 0);
  });

  it("a read of /api/activity made on each turn event already agrees with it, even while the runtime is slow to exit", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const channel = (await request("POST", `/api/agents/${agent.id}/channels`)).body;
    const follower = await followTurns();

    await request("POST", `/api/channels/${channel.id}/messages`, { content: "hello" });
    await waitUntil(async () => follower.reads.length > 0);
    Effect.runSync(
      Queue.offerAll(turn, [
        { _tag: "SessionStarted", sessionId: "s1", billing: "fake" },
        { _tag: "Completed", sessionId: "s1", text: "Hello" },
      ]),
    );
    await waitUntil(async () => {
      const list: ReadonlyArray<Message> = (await request("GET", `/api/channels/${channel.id}/messages`)).body;
      return list.some((m) => m.role === "assistant" && m.status === "complete");
    });
    // The reply completed, but the runtime has not exited: the turn still runs and has not ended.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await activity()).toEqual([channel.id]);
    expect(follower.reads.map((read) => read.event)).toEqual(["TurnStarted"]);

    Effect.runSync(Queue.end(turn));
    await waitUntil(async () => follower.reads.length > 1);
    await follower.stop();

    expect(follower.reads).toEqual([
      { event: "TurnStarted", channelId: channel.id, working: [channel.id] },
      { event: "TurnEnded", channelId: channel.id, working: [] },
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
          ? Effect.suspend(() => chat?.activeChannels ?? Effect.succeed([])).pipe(
              Effect.flatMap((working) =>
                Effect.sync(() => seen.push({ event: event._tag, channelId: event.channelId, working })),
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
  it("a stopped turn is announced ended only once its runtime has finished shutting down", async () => {
    const result = await atPublish((seen, exit) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const channel = yield* chat.createChannel(AgentId.make("wren"));
        yield* chat.sendPrompt(channel.id, "write a poem");
        yield* until(() => seen.length === 1);
        yield* chat.stop(channel.id);
        // The runtime holds its shutdown: the turn still runs, and its end is not announced.
        yield* Effect.sleep("50 millis");
        const whileExiting = { running: yield* chat.activeChannels, announced: seen.length };
        yield* Deferred.succeed(exit, undefined);
        yield* until(() => seen.length === 2);
        return { channelId: channel.id as ChannelId, whileExiting, seen };
      }),
    );

    expect(result.whileExiting).toEqual({ running: [result.channelId], announced: 1 });
    expect(result.seen).toEqual([
      { event: "TurnStarted", channelId: result.channelId, working: [result.channelId] },
      { event: "TurnEnded", channelId: result.channelId, working: [] },
    ]);
  });
});
