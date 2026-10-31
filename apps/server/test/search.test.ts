import { NodeHttpServer } from "@effect/platform-node";
import type { SearchHit } from "@hobbots/domain";
import { HobbotsRepository, SearchIndex, SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HobAdmission } from "../src/admission.ts";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";
import { HobService } from "../src/hobs.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobLifecycle } from "../src/lifecycle.ts";
import { HobTools } from "../src/tools.ts";

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

// A fresh database per test: the whole API over the test database, with the fake runtime.
beforeEach(() => {
  const Persistence = Layer.mergeAll(HobbotsRepository.layer, SetupRepository.layer, SearchIndex.layer).pipe(
    Layer.provideMerge(TestDatabase),
  );
  const App = HobLifecycle.layer
    .pipe(
      Layer.provideMerge(Layer.mergeAll(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)), HobService.layer)),
    )
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Persistence,
          EventBus.layer,
          HobAdmission.layer,
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

const request = async (method: string, path: string, body?: unknown) => {
  const response = await handler(
    new Request(
      `http://localhost:4317${path}`,
      body === undefined
        ? { method }
        : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
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
  // covers CH-006
  it("[TC-CH-064] finds a thread by a word from its messages once the reply finishes", async () => {
    const agent = (await request("POST", "/api/agents", hob)).body;
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "Where did I put the lanterns?" });

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
    expect(hit?.thread).toMatchObject({ id: thread.id, agentId: agent.id });
    expect(hit?.matches.map((m) => m.role)).toEqual(["assistant", "user"]);

    expect((await search("")).body).toEqual([]);
    expect((await search("nothing here")).body).toEqual([]);
    expect((await search("x".repeat(201))).status).toBe(400);
  });
});
