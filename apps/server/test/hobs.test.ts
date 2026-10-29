import { NodeHttpServer } from "@effect/platform-node";
import { type Agent, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime, type PromptRequest, RuntimeAdapter } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";
import { checkBrain, HobService } from "../src/hobs.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";

const hob = {
  name: "Wren",
  craft: "Scribe",
  lookSeed: 2 ** 32 - 1,
  lookColor: "moss",
  runtime: "claude-code",
  model: "fake-thinker",
  effort: "high",
  instructions: "Write short answers.",
};

let prompts: Array<PromptRequest>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(() => {
  prompts = [];
  const fake = makeFakeRuntime();
  const runtime = Layer.succeed(RuntimeAdapter, {
    ...fake,
    sendPrompt: (request) => {
      prompts.push(request);
      return fake.sendPrompt(request);
    },
  });
  const App = Layer.mergeAll(ChatService.layer, HobService.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepository.layer.pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        runtime,
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
    new Request(`http://localhost:4364${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

describe("creating hobs", () => {
  // covers AG-001
  it("[TC-AG-002] creates a hob that appears in the hob list and chats with its chosen model and effort", async () => {
    const created = await request("POST", "/api/agents", hob);
    expect(created.status).toBe(200);
    const agent: Agent = created.body;
    expect(agent).toMatchObject(hob);

    const list = await request("GET", "/api/agents");
    expect(list.body).toEqual([agent]);

    const thread = await request("POST", `/api/agents/${agent.id}/threads`);
    await request("POST", `/api/threads/${thread.body.id}/messages`, { content: "hello" });
    // The turn runs in the background; its request is recorded as soon as it starts.
    await Effect.runPromise(
      Effect.suspend(() => (prompts.length > 0 ? Effect.void : Effect.fail("waiting"))).pipe(
        Effect.retry(Schedule.spaced("5 millis")),
      ),
    );
    expect(prompts.map((p) => [p.model, p.effort, p.instructions])).toEqual([
      ["fake-thinker", "high", "Write short answers."],
    ]);
  });

  // covers AG-001
  it("[TC-AG-003] rejects invalid input with a typed error and creates nothing", async () => {
    const blankName = await request("POST", "/api/agents", { ...hob, name: "  " });
    expect(blankName).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "name" } });

    const badColor = await request("POST", "/api/agents", { ...hob, lookColor: "plaid" });
    expect(badColor).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "lookColor" } });

    const bigSeed = await request("POST", "/api/agents", { ...hob, lookSeed: 2 ** 32 });
    expect(bigSeed).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "lookSeed" } });

    const unknownModel = await request("POST", "/api/agents", { ...hob, model: "gpt-9" });
    expect(unknownModel).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "model" } });

    const noEffort = await request("POST", "/api/agents", { ...hob, model: "fake-quick" });
    expect(noEffort).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "effort" } });

    expect((await request("GET", "/api/agents")).body).toEqual([]);
  });

  // covers AG-001, AG-005
  it("[TC-AG-004] lists the models the runtime offers for the picker", async () => {
    const models = await request("GET", "/api/runtimes/claude-code/models");
    expect(models.status).toBe(200);
    expect(models.body.source).toBe("runtime");
    expect(models.body.models.map((m: RuntimeModel) => [m.id, m.efforts.length])).toEqual([
      ["fake-thinker", 5],
      ["fake-quick", 0],
    ]);
  });
});

describe("checking a hob's brain", () => {
  const offered = new RuntimeModels({
    runtime: "claude-code",
    source: "runtime",
    models: [
      new RuntimeModel({ id: "default", displayName: "Default", description: "", efforts: ["low", "high"] }),
      new RuntimeModel({ id: "old", displayName: "Old", description: "", efforts: [] }),
    ],
  });

  it("accepts the runtime's defaults and any offered pair", () => {
    expect(checkBrain(offered, { model: null, effort: null })).toBeUndefined();
    expect(checkBrain(offered, { model: "default", effort: "high" })).toBeUndefined();
    expect(checkBrain(offered, { model: "old", effort: null })).toBeUndefined();
  });

  it("checks a default model's effort against the runtime's default entry", () => {
    expect(checkBrain(offered, { model: null, effort: "max" })?.field).toBe("effort");
    expect(checkBrain(offered, { model: null, effort: "low" })).toBeUndefined();
  });

  it("names the field the runtime does not offer", () => {
    expect(checkBrain(offered, { model: "missing", effort: null })?.field).toBe("model");
    expect(checkBrain(offered, { model: "old", effort: "low" })?.message).toBe("Old takes no effort setting");
  });
});
