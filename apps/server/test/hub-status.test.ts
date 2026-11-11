import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
  RuntimeAdapter,
  type RuntimeEvent,
  TaskRepository,
} from "@hobbots/agents";
import {
  type Agent,
  noStatus,
  roleFields,
  type StatusEvent,
  type StatusSnapshot,
  type StatusView,
  shownStatus,
  withSnapshot,
  withStatusEvent,
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
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { type Cause, Effect, Layer, Queue, Schedule, Stream } from "effect";
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

let turn: Queue.Queue<RuntimeEvent, Cause.Done>;
let handler: (request: Request) => Promise<Response>;
// While set, every read of the failed Tasks fails, as a database that briefly cannot answer does.
let failing = false;
let failedReads = 0;
let dispose: () => Promise<void>;

const FlakyTasks = Layer.effect(
  TaskRepository,
  Effect.map(TaskRepository, (tasks) => ({
    ...tasks,
    listFailedTasks: Effect.suspend(() => {
      if (!failing) return tasks.listFailedTasks;
      failedReads += 1;
      return Effect.die(new Error("The database did not answer"));
    }),
  })),
).pipe(Layer.provide(TaskRepositoryLive));

beforeEach(() => {
  failing = false;
  failedReads = 0;
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
          FlakyTasks,
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

const waitUntil = (check: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.promise(check).pipe(
      Effect.flatMap((done) => (done ? Effect.void : Effect.fail("not yet" as const))),
      Effect.retry({ schedule: Schedule.spaced("5 millis") }),
      Effect.timeout("10 seconds"),
    ),
  );

const status = async (): Promise<StatusSnapshot> => (await request("GET", "/api/status")).body;

/** What a client shows: each busy thread's run and reply, and each hob's presence. */
const shown = (view: StatusView) => {
  const { runs, hobs } = shownStatus(view);
  return {
    threads: Object.fromEntries(runs.map((run) => [run.threadId, `${run.run}/${run.reply ?? "-"}`])),
    hobs: Object.fromEntries(hobs.map((presence) => [presence.agentId, presence.state])),
  };
};
type Shown = ReturnType<typeof shown>;

/**
 * Follows `/api/events` as a client does: on every `Ready` it drops the status it held and reads
 * `/api/status`, folding the `status` events around it with the domain's rules.
 */
const followStatus = async () => {
  const response = await handler(new Request("http://localhost:4381/api/events", { headers: AS_WINDOW }));
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const published: Array<number> = [];
  let view: StatusView = noStatus;
  let frames: Array<Event> = [];
  const parser = makeParser((event) => {
    if (event._tag === "Event" && (event.event === "status" || event.event === "ready")) frames.push(event);
  });
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
      const arrived = frames;
      frames = [];
      for (const frame of arrived) {
        if (frame.event === "ready") {
          view = withSnapshot(noStatus, await status());
          continue;
        }
        const event: StatusEvent = JSON.parse(frame.data);
        if (event._tag === "ThreadRunChanged") published.push(event.run.revision);
        view = withStatusEvent(view, event);
      }
    }
  };
  const pumping = pump().catch(() => undefined);
  return { shown: () => shown(view), published, stop: () => reader.cancel().then(() => pumping) };
};

type Follower = Awaited<ReturnType<typeof followStatus>>;

/** Waits until every follower shows what the hub reports now, and that is `expected`. */
const allShow = (followers: ReadonlyArray<Follower>, expected: Shown) =>
  waitUntil(async () => {
    const now = shown(withSnapshot(noStatus, await status()));
    return (
      JSON.stringify(now) === JSON.stringify(expected) &&
      followers.every((follower) => JSON.stringify(follower.shown()) === JSON.stringify(expected))
    );
  });

const offer = (...events: ReadonlyArray<RuntimeEvent>) => Effect.runSync(Queue.offerAll(turn, events));

// Each wait has its own 10-second limit, so a test may take longer than the default 5 seconds.
describe("hub status", { timeout: 30_000 }, () => {
  // covers CH-001, UX-001
  it("[TC-CH-294] a client that connects mid-turn shows the same thread run and hob presence as one connected throughout", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const throughout = await followStatus();
    await allShow([throughout], { threads: {}, hobs: { [agent.id]: "idle" } });

    await request("POST", `/api/threads/${thread.id}/messages`, { content: "hello" });
    await allShow([throughout], { threads: { [thread.id]: "running/thinking" }, hobs: { [agent.id]: "thinking" } });

    offer({ _tag: "SessionStarted", sessionId: "s1", billing: "fake" }, { _tag: "TextDelta", text: "Hel" });
    await allShow([throughout], { threads: { [thread.id]: "running/working" }, hobs: { [agent.id]: "working" } });

    const midTurn = await followStatus();
    const followers = [throughout, midTurn];
    await allShow(followers, { threads: { [thread.id]: "running/working" }, hobs: { [agent.id]: "working" } });

    // The reply is complete, but the runtime has not exited: the run goes on with no reply.
    offer({ _tag: "Completed", sessionId: "s1", text: "Hello" });
    await allShow(followers, { threads: { [thread.id]: "running/-" }, hobs: { [agent.id]: "idle" } });

    Effect.runSync(Queue.end(turn));
    await allShow(followers, { threads: {}, hobs: { [agent.id]: "idle" } });

    await request("POST", `/api/agents/${agent.id}/pause`);
    await allShow(followers, { threads: {}, hobs: { [agent.id]: "paused" } });

    await Promise.all(followers.map((follower) => follower.stop()));
    // Each transition of the run is published once: its revisions run from 1 with no gap or repeat.
    expect(throughout.published).toEqual(throughout.published.map((_, index) => index + 1));
    expect(throughout.published.length).toBeGreaterThanOrEqual(4);
  });

  // covers UX-001
  it("[TC-CH-295] a retired hob's presence leaves every client, connected or connecting, and comes back with the hob", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const connected = await followStatus();
    await allShow([connected], { threads: {}, hobs: { [agent.id]: "idle" } });

    expect((await request("POST", `/api/agents/${agent.id}/retire`, { openWork: "finish-first" })).status).toBe(200);
    const connecting = await followStatus();
    await allShow([connected, connecting], { threads: {}, hobs: {} });

    // Brought back, it has a presence again on both.
    expect((await request("POST", `/api/agents/${agent.id}/bring-back`)).status).toBe(200);
    await allShow([connected, connecting], { threads: {}, hobs: { [agent.id]: "idle" } });
    await Promise.all([connected.stop(), connecting.stop()]);
  });

  // covers UX-001
  it("[TC-CH-296] a presence the hub could not read is read again until it can, with no later change", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const follower = await followStatus();
    await allShow([follower], { threads: {}, hobs: { [agent.id]: "idle" } });

    failing = true;
    await request("POST", `/api/agents/${agent.id}/pause`);
    await waitUntil(async () => failedReads >= 2);
    expect(follower.shown().hobs).toEqual({ [agent.id]: "idle" });
    // Nothing else changes from here on: only the hub trying again brings the pause.
    failing = false;
    await allShow([follower], { threads: {}, hobs: { [agent.id]: "paused" } });
    await follower.stop();
  });
});
