import { NodeHttpServer } from "@effect/platform-node";
import { type Agent, type Message, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { HobbotsRepository, SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime, type PromptRequest, RuntimeAdapter } from "@hobbots/runtimes";
import { Effect, Layer, Schedule, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";
import { checkBrain, HobService } from "../src/hobs.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobLifecycle } from "../src/lifecycle.ts";

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
// Each turn waits for this before the runtime replies, so a test can act while a reply is running.
let replyGate: Promise<void>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(() => {
  prompts = [];
  replyGate = Promise.resolve();
  const fake = makeFakeRuntime();
  const runtime = Layer.succeed(RuntimeAdapter, {
    ...fake,
    sendPrompt: (request) => {
      prompts.push(request);
      const gate = replyGate;
      return Stream.fromEffect(Effect.promise(() => gate)).pipe(Stream.drain, Stream.concat(fake.sendPrompt(request)));
    },
  });
  const App = HobLifecycle.layer
    .pipe(Layer.provideMerge(Layer.mergeAll(ChatService.layer, HobService.layer)))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(HobbotsRepository.layer, SetupRepository.layer).pipe(Layer.provideMerge(TestDatabase)),
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

  // covers AG-001
  it("[TC-AG-007] returns the hob created first when a create is retried with the same id", async () => {
    const id = crypto.randomUUID();
    const first = await request("POST", "/api/agents", { ...hob, id });
    expect(first).toMatchObject({ status: 200, body: { ...hob, id } });

    const retry = await request("POST", "/api/agents", { ...hob, id });
    expect(retry).toEqual(first);
    expect((await request("GET", "/api/agents")).body).toEqual([first.body]);
  });

  // covers AG-001
  it("[TC-AG-008] rejects a create that reuses an id for different choices or is not a UUID", async () => {
    const id = crypto.randomUUID();
    const first = await request("POST", "/api/agents", { ...hob, id });

    const other = await request("POST", "/api/agents", { ...hob, id, name: "Moss" });
    expect(other).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "id" } });

    const notUuid = await request("POST", "/api/agents", { ...hob, id: "wren" });
    expect(notUuid).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "id" } });

    expect((await request("GET", "/api/agents")).body).toEqual([first.body]);
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

const waitFor = (ready: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.tryPromise(ready).pipe(
      Effect.flatMap((done) => (done ? Effect.void : Effect.fail("waiting"))),
      Effect.retry(Schedule.spaced("5 millis")),
    ),
  );

describe("editing hobs", () => {
  // covers AG-002
  it("[TC-AG-022] runs a reply with the configuration it started with and the next reply with the edit", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    expect(agent.configVersion).toBe(1);
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const messages = async () => (await request("GET", `/api/threads/${thread.id}/messages`)).body as Array<Message>;
    const settled = () => waitFor(async () => (await messages()).every((m) => m.status !== "streaming"));

    let release = () => {};
    replyGate = new Promise((resolve) => {
      release = resolve;
    });
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "first" });
    await waitFor(async () => prompts.length === 1);

    // The edit lands while the first reply is still running.
    const edited = await request("PATCH", `/api/agents/${agent.id}`, { instructions: "Write long answers." });
    expect(edited).toMatchObject({
      status: 200,
      body: { ...hob, id: agent.id, instructions: "Write long answers.", configVersion: 2 },
    });
    expect((await messages()).map((m) => m.status)).toEqual(["complete", "streaming"]);
    release();
    await settled();

    await request("POST", `/api/threads/${thread.id}/messages`, { content: "second" });
    await settled();

    expect(prompts.map((p) => p.instructions)).toEqual(["Write short answers.", "Write long answers."]);
    expect((await messages()).map((m) => [m.role, m.content, m.configVersion])).toEqual([
      ["user", "first", null],
      ["assistant", "Echo: first", 1],
      ["user", "second", null],
      ["assistant", "Echo: second", 2],
    ]);
    expect((await request("GET", "/api/agents")).body).toEqual([edited.body]);
  });

  // covers AG-002
  it("[TC-AG-023] validates an edit, keeps the hob unchanged when it fails and adds no version for a no-op", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;

    const unknownModel = await request("PATCH", `/api/agents/${agent.id}`, { model: "gpt-9" });
    expect(unknownModel).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "model" } });
    // The effort is checked against the model the hob keeps.
    const noEffort = await request("PATCH", `/api/agents/${agent.id}`, { model: "fake-quick" });
    expect(noEffort).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "effort" } });
    const blankCraft = await request("PATCH", `/api/agents/${agent.id}`, { craft: " " });
    expect(blankCraft).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "craft" } });

    const missing = await request("PATCH", `/api/agents/${crypto.randomUUID()}`, { instructions: "" });
    expect(missing).toMatchObject({ status: 404, body: { _tag: "AgentNotFound" } });

    const same = await request("PATCH", `/api/agents/${agent.id}`, { instructions: hob.instructions });
    expect(same).toEqual({ status: 200, body: agent });

    const quick = await request("PATCH", `/api/agents/${agent.id}`, { model: "fake-quick", effort: null });
    expect(quick.body).toMatchObject({ model: "fake-quick", effort: null, configVersion: 2 });
    expect((await request("GET", "/api/agents")).body).toEqual([quick.body]);
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
