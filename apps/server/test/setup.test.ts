import { NodeHttpServer } from "@effect/platform-node";
import { HobbotsRepository, SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";
import { HobService } from "../src/hobs.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

// A fresh database per test: the whole API over the test database, without seeded hobs.
beforeEach(() => {
  const Persistence = Layer.mergeAll(HobbotsRepository.layer, SetupRepository.layer).pipe(
    Layer.provideMerge(TestDatabase),
  );
  const App = Layer.mergeAll(ChatService.layer, HobService.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Persistence,
        EventBus.layer,
        FakeRuntimeLayer(),
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/data" }),
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

const request = (method: string, path: string, body?: unknown) =>
  handler(
    new Request(
      `http://localhost:4317${path}`,
      body === undefined
        ? { method }
        : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ),
  );

const connectedProviders = async (response: Response) =>
  ((await response.json()) as { connectedProviders: unknown }).connectedProviders;

describe("the setup API", () => {
  // covers OP-001, PE-001
  it("[TC-OP-004] reports a new installation's setup as not done, with no hobs", async () => {
    const setup = await request("GET", "/api/setup");
    expect(setup.status).toBe(200);
    expect(await setup.json()).toEqual({
      completed: false,
      safetyPreset: "balanced",
      approvedFolders: [],
      connectedProviders: [],
    });

    const hobs = await request("GET", "/api/agents");
    expect(await hobs.json()).toEqual([]);
  });

  // covers OP-001, PE-001
  it("[TC-OP-005] stores the preset and folders, completes setup and keeps the result", async () => {
    const chosen = await request("PATCH", "/api/setup", {
      safetyPreset: "trusting",
      approvedFolders: ["/Users/me/code", "/Users/me/notes", "/Users/me/code"],
    });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toEqual({
      completed: false,
      safetyPreset: "trusting",
      approvedFolders: ["/Users/me/code", "/Users/me/notes"],
      connectedProviders: [],
    });

    const finished = {
      completed: true,
      safetyPreset: "trusting",
      approvedFolders: ["/Users/me/code", "/Users/me/notes"],
      connectedProviders: [],
    };
    const done = await request("PATCH", "/api/setup", { completed: true });
    expect(await done.json()).toEqual(finished);
    expect(await (await request("GET", "/api/setup")).json()).toEqual(finished);
  });

  // covers OP-001
  it("[TC-OP-006] rejects an unknown preset, an empty folder and reopening setup", async () => {
    for (const body of [{ safetyPreset: "reckless" }, { approvedFolders: [""] }, { completed: false }]) {
      const response = await request("PATCH", "/api/setup", body);
      expect(response.status).toBe(400);
    }
    expect(await (await request("GET", "/api/setup")).json()).toEqual({
      completed: false,
      safetyPreset: "balanced",
      approvedFolders: [],
      connectedProviders: [],
    });
  });

  // covers OP-001, DP-001
  it("[TC-OP-010] connects and disconnects a provider and keeps the choice", async () => {
    const connected = await request("PATCH", "/api/setup", { connectedProviders: ["claude-code", "claude-code"] });
    expect(connected.status).toBe(200);
    expect(await connectedProviders(connected)).toEqual(["claude-code"]);
    expect(await connectedProviders(await request("GET", "/api/setup"))).toEqual(["claude-code"]);

    const disconnected = await request("PATCH", "/api/setup", { connectedProviders: [] });
    expect(await connectedProviders(disconnected)).toEqual([]);
    expect(await connectedProviders(await request("GET", "/api/setup"))).toEqual([]);
  });

  // covers OP-001
  it("[TC-OP-011] rejects a provider Hobbots does not know", async () => {
    const response = await request("PATCH", "/api/setup", { connectedProviders: ["gemini"] });
    expect(response.status).toBe(400);
    expect(await connectedProviders(await request("GET", "/api/setup"))).toEqual([]);
  });
});
