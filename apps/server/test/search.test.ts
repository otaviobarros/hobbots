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
} from "@hobbots/agents";
import type { SearchHit } from "@hobbots/domain";
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
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

let handler: (request: Request) => Promise<Response>;
let admission: typeof HobAdmission.Service;
let dispose: () => Promise<void>;

// A fresh database per test: the whole API over the test database, with the fake runtime.
beforeEach(() => {
  const Persistence = Layer.mergeAll(
    HobbotsRepositoryLive,
    ApprovalRepositoryLive,
    GrantRepositoryLive,
    TaskRepositoryLive,
    EventJournal.layer,
    BackpackLive,
    SetupRepository.layer,
    SearchIndex.layer,
  ).pipe(Layer.provideMerge(TestDatabase));
  const App = HobLifecycle.layer
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
          ApprovalService.layer,
          GrantService.layer,
          HobService.layer,
          PermissionSummary.layer,
        ),
      ),
    )
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Persistence,
          EventBus.layer,
          Layer.effectDiscard(HobAdmission.use((held) => Effect.sync(() => (admission = held)))).pipe(
            Layer.provideMerge(HobAdmission.layer),
          ),
          NodeFolderChecks,
          FakeRuntimeLayer(),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/data" }),
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
    new Request(
      `http://localhost:4317${path}`,
      body === undefined
        ? { method, headers: AS_WINDOW }
        : { method, headers: { "content-type": "application/json", ...AS_WINDOW }, body: JSON.stringify(body) },
    ),
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};

const hob = {
  name: "Wren",
  role: null,
  roleTitle: "Guide",
  sigil: "assistant",
  hat: null,
  tool: null,
  lookSeed: 7,
  lookColor: "moss",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
};

const search = (q: string) => request("GET", `/api/search?q=${encodeURIComponent(q)}`);

describe("the search API", () => {
  it("finds a channel by a word from its messages once the reply finishes", async () => {
    const agent = (await request("POST", "/api/agents", hob)).body;
    const channel = (await request("POST", `/api/agents/${agent.id}/channels`)).body;
    await request("POST", `/api/channels/${channel.id}/messages`, { content: "Where did I put the lanterns?" });

    // The fake runtime echoes the prompt; both the prompt and the finished reply match.
    const hits = await Effect.runPromise(
      Effect.promise(() => search("lantern")).pipe(
        Effect.flatMap((response) =>
          (response.body as Array<SearchHit>)[0]?.matchCount === 2 ? Effect.succeed(response) : Effect.fail("waiting"),
        ),
        Effect.retry(Schedule.spaced("5 millis")),
        Effect.timeout("2 seconds"),
      ),
    );
    expect(hits.status).toBe(200);
    const [hit] = hits.body as Array<SearchHit>;
    expect(hit?.channel).toMatchObject({ id: channel.id, agentId: agent.id });
    expect(hit?.matches.map((m) => m.role)).toEqual(["assistant", "user"]);

    expect((await search("")).body).toEqual([]);
    expect((await search("nothing here")).body).toEqual([]);
    expect((await search("x".repeat(201))).status).toBe(400);
  });
});

describe("the archive API", () => {
  it("archives and restores over HTTP: archived channels listed apart, sends refused", async () => {
    const agent = (await request("POST", "/api/agents", hob)).body;
    const channel = (await request("POST", `/api/agents/${agent.id}/channels`)).body;

    const archived = await request("POST", `/api/channels/${channel.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    expect((await request("GET", `/api/agents/${agent.id}/channels`)).body).toEqual([]);
    const listed = (await request("GET", `/api/agents/${agent.id}/channels?archived=true`)).body;
    expect(listed.map((t: { id: string }) => t.id)).toEqual([channel.id]);

    const sent = await request("POST", `/api/channels/${channel.id}/messages`, { content: "More" });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ _tag: "ChannelArchived", channelId: channel.id });

    const restored = await request("POST", `/api/channels/${channel.id}/restore`);
    expect(restored.body.archivedAt).toBeNull();
    expect((await request("GET", `/api/agents/${agent.id}/channels`)).body).toHaveLength(1);

    await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "finish" });
    const refused = await request("POST", `/api/channels/${channel.id}/archive`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ _tag: "ChannelArchiveRefused", reason: "hob-retired" });
  });

  it("never changes the hob's default brain for a channel archived while the switch waits", async () => {
    const agent = (await request("POST", "/api/agents", hob)).body;
    const channel = (await request("POST", `/api/agents/${agent.id}/channels`)).body;
    const brain = { brain: { runtime: "claude-code", model: "fake-quick", effort: null }, makeDefault: true };
    // While the hob's lock is held, the archive queues first and the switch after it.
    const pending = await Effect.runPromise(
      admission.withHob(
        agent.id,
        Effect.promise(async () => {
          const archived = request("POST", `/api/channels/${channel.id}/archive`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          const switched = request("PUT", `/api/channels/${channel.id}/brain`, brain);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { archived, switched };
        }),
      ),
    );
    expect((await pending.archived).status).toBe(200);
    const switched = await pending.switched;
    expect(switched.status).toBe(409);
    expect(switched.body).toMatchObject({ _tag: "ChannelArchived" });
    const after = (await request("GET", "/api/agents")).body[0];
    expect([after.configVersion, after.model]).toEqual([agent.configVersion, agent.model]);
  });
});
