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
} from "@hobbots/agents";
import { type Agent, type HobPresence, roleFields, type ThreadRunStatus } from "@hobbots/domain";
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
      Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
    ),
  );

interface HubStatusRead {
  readonly runsRevision: number;
  readonly runs: ReadonlyArray<ThreadRunStatus>;
  readonly hobs: ReadonlyArray<HobPresence>;
}

/** What a client shows: each busy thread's run and reply, and each hob's presence. */
interface Shown {
  readonly threads: Readonly<Record<string, string>>;
  readonly hobs: Readonly<Record<string, string>>;
}

const status = async (): Promise<HubStatusRead> => (await request("GET", "/api/status")).body;

const shownBy = (read: HubStatusRead): Shown => ({
  threads: Object.fromEntries(read.runs.map((run) => [run.threadId, `${run.run}/${run.reply ?? "-"}`])),
  hobs: Object.fromEntries(read.hobs.map((hob) => [hob.agentId, hob.state])),
});

/**
 * Follows `/api/events` as a client does: on `Ready` it reads `/api/status` as its snapshot, and it
 * keeps, per thread and per hob, whichever of the snapshot and each `status` frame has the higher
 * revision. A thread the snapshot leaves out is idle as of its runs revision.
 */
const followStatus = async () => {
  const response = await handler(new Request("http://localhost:4381/api/events", { headers: AS_WINDOW }));
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const runs = new Map<string, ThreadRunStatus>();
  const hobs = new Map<string, HobPresence>();
  const published: Array<number> = [];
  let runsRevision = -1;
  let frames: Array<Event> = [];
  const parser = makeParser((event) => {
    if (event._tag === "Event" && (event.event === "status" || event.event === "ready")) frames.push(event);
  });
  const takeRun = (run: ThreadRunStatus) => {
    if (run.revision <= runsRevision || (runs.get(run.threadId)?.revision ?? -1) >= run.revision) return;
    runs.set(run.threadId, run);
  };
  const takeHob = (presence: HobPresence) => {
    if ((hobs.get(presence.agentId)?.revision ?? -1) < presence.revision) hobs.set(presence.agentId, presence);
  };
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
      const arrived = frames;
      frames = [];
      for (const frame of arrived) {
        if (frame.event === "ready") {
          const snapshot = await status();
          for (const [threadId, run] of runs) if (run.revision <= snapshot.runsRevision) runs.delete(threadId);
          runsRevision = snapshot.runsRevision;
          for (const run of snapshot.runs) runs.set(run.threadId, run);
          for (const presence of snapshot.hobs) takeHob(presence);
          continue;
        }
        const data = JSON.parse(frame.data);
        if (data._tag === "ThreadRunChanged") {
          published.push(data.run.revision);
          takeRun(data.run);
        } else if (data._tag === "HobPresenceChanged") takeHob(data.presence);
      }
    }
  };
  const pumping = pump().catch(() => undefined);
  const shown = (): Shown => ({
    threads: Object.fromEntries(
      [...runs.values()]
        .filter((run) => run.run !== "idle")
        .map((run) => [run.threadId, `${run.run}/${run.reply ?? "-"}`]),
    ),
    hobs: Object.fromEntries([...hobs.values()].map((presence) => [presence.agentId, presence.state])),
  });
  return { shown, published, stop: () => reader.cancel().then(() => pumping) };
};

type Follower = Awaited<ReturnType<typeof followStatus>>;

/** Waits until every follower shows what the hub reports now, and that is `expected`. */
const allShow = (followers: ReadonlyArray<Follower>, expected: Shown) =>
  waitUntil(async () => {
    const now = shownBy(await status());
    return (
      JSON.stringify(now) === JSON.stringify(expected) &&
      followers.every((follower) => JSON.stringify(follower.shown()) === JSON.stringify(expected))
    );
  });

const offer = (...events: ReadonlyArray<RuntimeEvent>) => Effect.runSync(Queue.offerAll(turn, events));

describe("hub status", () => {
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
});
