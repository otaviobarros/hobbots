import { NodeHttpServer } from "@effect/platform-node";
import type { Agent, Message } from "@hobbots/domain";
import { HobbotsRepository, SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";
import { HobService } from "../src/hobs.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobLifecycle } from "../src/lifecycle.ts";

const hob = {
  name: "Wren",
  craft: "Scribe",
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
  const App = HobLifecycle.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(ChatService.layer, HobService.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(HobbotsRepository.layer, SetupRepository.layer).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        FakeRuntimeLayer({ delay: "40 millis" }),
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/tmp" }),
      ),
    ),
  );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(Layer.provide(App), Layer.provide(NodeHttpServer.layerHttpServices)),
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

const summon = async () => {
  const agent: Agent = (await request("POST", "/api/agents", hob)).body;
  const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
  return { agent, thread };
};

const messages = async (threadId: string): Promise<ReadonlyArray<Message>> =>
  (await request("GET", `/api/threads/${threadId}/messages`)).body;

// Waits until no reply in the thread is still streaming.
const settled = (threadId: string) =>
  Effect.runPromise(
    Effect.promise(() => messages(threadId)).pipe(
      Effect.flatMap((list) => (list.some((m) => m.status === "streaming") ? Effect.fail("streaming") : Effect.void)),
      Effect.retry(Schedule.spaced("10 millis")),
    ),
  );

describe("pausing and waking hobs", () => {
  // covers AG-006
  it("[TC-AG-030] refuses new messages while paused, keeps the threads readable and chats again once woken", async () => {
    const { agent, thread } = await summon();

    const paused = await request("POST", `/api/agents/${agent.id}/pause`);
    expect(paused).toMatchObject({ status: 200, body: { id: agent.id, status: "paused" } });
    // Pausing twice changes nothing.
    expect((await request("POST", `/api/agents/${agent.id}/pause`)).body.status).toBe("paused");

    const refused = await request("POST", `/api/threads/${thread.id}/messages`, { content: "hello" });
    expect(refused).toMatchObject({
      status: 409,
      body: { _tag: "HobUnavailable", agentId: agent.id, status: "paused" },
    });
    const noThread = await request("POST", `/api/agents/${agent.id}/threads`);
    expect(noThread).toMatchObject({ status: 409, body: { _tag: "HobUnavailable" } });
    expect(await messages(thread.id)).toEqual([]);
    expect((await request("GET", `/api/agents/${agent.id}/threads`)).body).toHaveLength(1);
    // A paused hob is still listed, with its state.
    expect((await request("GET", "/api/agents")).body).toMatchObject([{ id: agent.id, status: "paused" }]);

    const woken = await request("POST", `/api/agents/${agent.id}/wake`);
    expect(woken).toMatchObject({ status: 200, body: { status: "active" } });
    expect((await request("POST", `/api/threads/${thread.id}/messages`, { content: "hello" })).status).toBe(200);
    await settled(thread.id);
    expect((await messages(thread.id)).map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
  });

  // covers AG-006
  it("[TC-AG-031] reports a missing hob and lets a running reply finish when its hob is paused", async () => {
    const missing = await request("POST", `/api/agents/${crypto.randomUUID()}/pause`);
    expect(missing).toMatchObject({ status: 404, body: { _tag: "AgentNotFound" } });

    const { agent, thread } = await summon();
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "hello" });
    await request("POST", `/api/agents/${agent.id}/pause`);
    await settled(thread.id);
    expect((await messages(thread.id)).at(-1)).toMatchObject({ content: "Echo: hello", status: "complete" });
  });
});

describe("retiring hobs", () => {
  // covers AG-006
  it("[TC-AG-032] refuses new work for a retired hob, keeps its threads readable and lists it under archived hobs", async () => {
    const { agent, thread } = await summon();
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "hello" });
    await settled(thread.id);

    const retired = await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "finish" });
    expect(retired).toMatchObject({ status: 200, body: { id: agent.id, status: "retired" } });

    const refused = await request("POST", `/api/threads/${thread.id}/messages`, { content: "again" });
    expect(refused).toMatchObject({ status: 409, body: { _tag: "HobUnavailable", status: "retired" } });
    expect((await request("POST", `/api/agents/${agent.id}/threads`)).status).toBe(409);
    // Retiring is final: it cannot be paused or woken, and retiring again changes nothing.
    expect((await request("POST", `/api/agents/${agent.id}/wake`)).body).toMatchObject({
      _tag: "HobUnavailable",
      status: "retired",
    });
    expect((await request("POST", `/api/agents/${agent.id}/pause`)).status).toBe(409);
    expect((await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "stop" })).status).toBe(200);

    expect((await messages(thread.id)).map((m) => m.content)).toEqual(["hello", "Echo: hello"]);
    expect((await request("GET", `/api/agents/${agent.id}/threads`)).body).toMatchObject([{ id: thread.id }]);
    expect((await request("GET", "/api/agents")).body).toEqual([]);
    expect((await request("GET", "/api/agents?status=retired")).body).toMatchObject([{ id: agent.id }]);
    expect((await request("GET", "/api/agents?status=active")).body).toEqual([]);
  });

  // covers AG-006, CH-004
  it("[TC-AG-033] stops a running reply and records it as interrupted when retiring with stop", async () => {
    const { agent, thread } = await summon();
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "a long question" });

    await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "stop" });
    // The retire request returns once the reply is stopped and saved.
    expect((await messages(thread.id)).at(-1)?.status).toBe("interrupted");
    expect((await request("GET", "/api/activity")).body).toEqual({ working: [] });
  });

  // covers AG-006
  it("[TC-AG-034] lets a running reply finish when retiring with finish, and asks which", async () => {
    const { agent, thread } = await summon();
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "hello" });

    const unasked = await request("POST", `/api/agents/${agent.id}/retire`, {});
    expect(unasked.status).toBe(400);
    expect((await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "finish" })).status).toBe(200);
    expect((await messages(thread.id)).at(-1)?.status).toBe("streaming");
    await settled(thread.id);
    expect((await messages(thread.id)).at(-1)).toMatchObject({ content: "Echo: hello", status: "complete" });
  });
});
