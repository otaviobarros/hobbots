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
  WorkQuests,
  WorkToolsLive,
} from "@hobbots/agents";
import { type Agent, type Message, roleFields } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  WorkQuestRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { RetireWhenDone } from "../src/retire.ts";
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

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(() => {
  // Slow enough that a reply is still running when the test retires its hob.
  const App = RetireWhenDone.pipe(
    Layer.provideMerge(HobLifecycle.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ChatService.layer.pipe(
          Layer.provide(HobTools.chatOnly),
          Layer.provideMerge(WorkToolsLive.pipe(Layer.provideMerge(WorkQuests.layer))),
        ),
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
          WorkQuestRepositoryLive,
          EventJournal.layer,
          BackpackLive,
          SetupRepository.layer,
          SearchIndex.layer,
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        FakeRuntimeLayer({ delay: "40 millis" }),
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/tmp" }),
      ),
    ),
  );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(Layer.provide(TestDevices), Layer.provide(App), Layer.provide(NodeHttpServer.layerHttpServices)),
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

const summon = async () => {
  const agent: Agent = (await request("POST", "/api/agents", hob)).body;
  const channel = (await request("POST", `/api/agents/${agent.id}/channels`)).body;
  return { agent, channel };
};

const messages = async (channelId: string): Promise<ReadonlyArray<Message>> =>
  (await request("GET", `/api/channels/${channelId}/messages`)).body;

// Waits until no reply in the channel is still streaming and no message is queued.
const settled = (channelId: string) =>
  Effect.runPromise(
    Effect.promise(() => messages(channelId)).pipe(
      Effect.flatMap((list) =>
        list.some((m) => m.status === "streaming" || m.status === "queued") ? Effect.fail("busy") : Effect.void,
      ),
      Effect.retry(Schedule.spaced("10 millis")),
    ),
  );

describe("pausing and waking hobs", () => {
  it("queues messages while paused, refuses new channels, keeps the channels readable and runs the queue once woken", async () => {
    const { agent, channel } = await summon();

    const paused = await request("POST", `/api/agents/${agent.id}/pause`);
    expect(paused).toMatchObject({ status: 200, body: { id: agent.id, status: "paused" } });
    // Pausing twice changes nothing.
    expect((await request("POST", `/api/agents/${agent.id}/pause`)).body.status).toBe("paused");

    // A message waits for the hob instead of being refused (CH-008).
    const queued = await request("POST", `/api/channels/${channel.id}/messages`, { content: "hello" });
    expect(queued).toMatchObject({ status: 200, body: { userMessage: { status: "queued" }, assistantMessage: null } });
    const noChannel = await request("POST", `/api/agents/${agent.id}/channels`);
    expect(noChannel).toMatchObject({ status: 409, body: { _tag: "HobUnavailable" } });
    expect((await messages(channel.id)).map((m) => [m.role, m.status])).toEqual([["user", "queued"]]);
    expect((await request("GET", `/api/agents/${agent.id}/channels`)).body).toHaveLength(1);
    // A paused hob is still listed, with its state.
    expect((await request("GET", "/api/agents")).body).toMatchObject([{ id: agent.id, status: "paused" }]);

    const woken = await request("POST", `/api/agents/${agent.id}/wake`);
    expect(woken).toMatchObject({ status: 200, body: { status: "active" } });
    await settled(channel.id);
    expect((await messages(channel.id)).map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
  });

  it("reports a missing hob and lets a running reply finish when its hob is paused", async () => {
    const missing = await request("POST", `/api/agents/${crypto.randomUUID()}/pause`);
    expect(missing).toMatchObject({ status: 404, body: { _tag: "AgentNotFound" } });

    const { agent, channel } = await summon();
    await request("POST", `/api/channels/${channel.id}/messages`, { content: "hello" });
    await request("POST", `/api/agents/${agent.id}/pause`);
    await settled(channel.id);
    expect((await messages(channel.id)).at(-1)).toMatchObject({ content: "Echo: hello", status: "complete" });
  });
});

describe("retiring hobs", () => {
  it("refuses new work for a retired hob, keeps its channels readable and lists it under archived hobs", async () => {
    const { agent, channel } = await summon();
    await request("POST", `/api/channels/${channel.id}/messages`, { content: "hello" });
    await settled(channel.id);

    const retired = await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "finish" });
    expect(retired).toMatchObject({ status: 200, body: { id: agent.id, status: "retired" } });
    const retiredAt = (retired.body as { retiredAt: string }).retiredAt;
    expect(new Date(retiredAt).toISOString()).toBe(retiredAt);

    const refused = await request("POST", `/api/channels/${channel.id}/messages`, { content: "again" });
    expect(refused).toMatchObject({ status: 409, body: { _tag: "HobUnavailable", status: "retired" } });
    expect((await request("POST", `/api/agents/${agent.id}/channels`)).status).toBe(409);
    // A retired hob cannot be paused or woken, and retiring again changes nothing.
    expect((await request("POST", `/api/agents/${agent.id}/wake`)).body).toMatchObject({
      _tag: "HobUnavailable",
      status: "retired",
    });
    expect((await request("POST", `/api/agents/${agent.id}/pause`)).status).toBe(409);
    expect((await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "stop" })).status).toBe(200);

    expect((await messages(channel.id)).map((m) => m.content)).toEqual(["hello", "Echo: hello"]);
    expect((await request("GET", `/api/agents/${agent.id}/channels`)).body).toMatchObject([{ id: channel.id }]);
    expect((await request("GET", "/api/agents")).body).toEqual([]);
    // Archived hobs show when the hob retired; retiring again kept the first time.
    expect((await request("GET", "/api/agents?status=retired")).body).toMatchObject([{ id: agent.id, retiredAt }]);
    expect((await request("GET", "/api/agents?status=active")).body).toEqual([]);
  });

  it("brings a retired hob back active with its channels, and takes new work again", async () => {
    const { agent, channel } = await summon();
    await request("POST", `/api/channels/${channel.id}/messages`, { content: "hello" });
    await settled(channel.id);
    await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "finish" });

    const back = await request("POST", `/api/agents/${agent.id}/bring-back`);
    expect(back).toMatchObject({ status: 200, body: { id: agent.id, status: "active", retiredAt: null } });
    expect((await request("GET", "/api/agents")).body).toMatchObject([{ id: agent.id, status: "active" }]);
    expect((await request("GET", "/api/agents?status=retired")).body).toEqual([]);
    expect((await request("GET", `/api/agents/${agent.id}/channels`)).body).toMatchObject([{ id: channel.id }]);

    await request("POST", `/api/channels/${channel.id}/messages`, { content: "again" });
    await settled(channel.id);
    expect((await messages(channel.id)).map((m) => m.content)).toEqual([
      "hello",
      "Echo: hello",
      "again",
      "Echo: again",
    ]);
    // Bringing back an active hob changes nothing; a paused one is refused, and an unknown one is not found.
    expect((await request("POST", `/api/agents/${agent.id}/bring-back`)).body).toMatchObject({ status: "active" });
    await request("POST", `/api/agents/${agent.id}/pause`);
    expect((await request("POST", `/api/agents/${agent.id}/bring-back`)).body).toMatchObject({
      _tag: "HobUnavailable",
      status: "paused",
    });
    expect((await request("POST", "/api/agents/hob_nobody/bring-back")).status).toBe(404);
  });

  it("stops a running reply and records it as interrupted when retiring with stop", async () => {
    const { agent, channel } = await summon();
    await request("POST", `/api/channels/${channel.id}/messages`, { content: "a long question" });

    await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "stop" });
    // The retire request returns once the reply is stopped and saved.
    expect((await messages(channel.id)).at(-1)?.status).toBe("interrupted");
    expect((await request("GET", "/api/activity")).body).toEqual({ working: [] });
  });

  it("lists a hob's open work, retires one with none open at once when asked to finish first, and refuses a hand-over to itself", async () => {
    const { agent } = await summon();
    expect(await request("GET", `/api/agents/${agent.id}/open-work?handOverTo=${agent.id}`)).toMatchObject({
      status: 200,
      body: { agentId: agent.id, tasks: [], quests: [], approvals: [], backpackItems: [] },
    });
    expect((await request("GET", "/api/agents/hob_nobody/open-work")).status).toBe(404);

    const toItself = await request("POST", `/api/agents/${agent.id}/retire`, {
      openWork: "hand-over",
      handOverTo: agent.id,
    });
    expect(toItself).toMatchObject({ status: 409, body: { _tag: "HandOverRefused", agentId: agent.id } });
    expect((await request("GET", "/api/agents")).body).toMatchObject([{ id: agent.id, status: "active" }]);

    const retired = await request("POST", `/api/agents/${agent.id}/retire`, { openWork: "finish-first" });
    expect(retired).toMatchObject({ status: 200, body: { id: agent.id, status: "retired", retiring: null } });
    expect((await request("POST", `/api/agents/${agent.id}/retire`, { openWork: "finish-first" })).body).toMatchObject({
      _tag: "HobUnavailable",
      status: "retired",
    });
  });

  it("lets a running reply finish when retiring with finish, and asks which", async () => {
    const { agent, channel } = await summon();
    await request("POST", `/api/channels/${channel.id}/messages`, { content: "hello" });

    const unasked = await request("POST", `/api/agents/${agent.id}/retire`, {});
    expect(unasked.status).toBe(400);
    expect((await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "finish" })).status).toBe(200);
    expect((await messages(channel.id)).at(-1)?.status).toBe("streaming");
    await settled(channel.id);
    expect((await messages(channel.id)).at(-1)).toMatchObject({ content: "Echo: hello", status: "complete" });
  });

  it("waits for the hob's running Quest when retiring with finish first, and retires it once the Quest is done (#1596)", async () => {
    const { agent, channel } = await summon();
    const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
    const send = async (content: string) => {
      await request("POST", `/api/channels/${channel.id}/messages`, { content });
      await settled(channel.id);
    };
    await send(hub("start_work", { title: "Winter market page", goal: "A landing page.", done_when: ["It is live"] }));
    const quests = await request("GET", `/api/channels/${channel.id}/work-quests`);
    expect(quests.body).toMatchObject([{ title: "Winter market page", state: "active" }]);

    const work = await request("GET", `/api/agents/${agent.id}/open-work`);
    expect(work.body).toMatchObject({ tasks: [], quests: [{ title: "Winter market page", channelId: channel.id }] });
    const other: Agent = (await request("POST", "/api/agents", { ...hob, name: "Rook" })).body;
    const handOver = await request("POST", `/api/agents/${agent.id}/retire`, {
      openWork: "hand-over",
      handOverTo: other.id,
    });
    expect(handOver).toMatchObject({ status: 409, body: { _tag: "HandOverRefused" } });
    const waiting = await request("POST", `/api/agents/${agent.id}/retire`, { openWork: "finish-first" });
    expect(waiting).toMatchObject({ status: 200, body: { id: agent.id, status: "active", retiring: { by: {} } } });
    // It goes on where it runs the Quest, and finishing it is what retires it.
    await send(hub("finish_work", { result: "The page is live.", made: [] }));
    await Effect.runPromise(
      Effect.promise(() => request("GET", "/api/agents?status=retired")).pipe(
        Effect.flatMap(({ body }) =>
          body.some((each: Agent) => each.id === agent.id && each.status === "retired")
            ? Effect.void
            : Effect.fail("not yet"),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 300 }),
      ),
    );
    expect((await request("GET", `/api/channels/${channel.id}/work-quests`)).body).toMatchObject([{ state: "done" }]);
  });

  it("stops the Quests a hob runs when it retires at once, and starts none for a hob that is leaving (#1596)", async () => {
    const { agent, channel } = await summon();
    const start = `fake:hub start_work ${JSON.stringify({ title: "Winter market page", goal: "A page.", done_when: ["Live"] })}`;
    await request("POST", `/api/channels/${channel.id}/messages`, { content: start });
    await settled(channel.id);
    expect((await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "stop" })).status).toBe(200);
    expect((await request("GET", `/api/channels/${channel.id}/work-quests`)).body).toMatchObject([
      { state: "stopped" },
    ]);
    expect((await request("GET", `/api/agents/${agent.id}/open-work`)).body).toMatchObject({ quests: [] });
  });
});
