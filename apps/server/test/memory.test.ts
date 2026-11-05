import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  HobTools,
  MemoryStore,
  type MemoryStoreShape,
  PermissionSummary,
} from "@hobbots/agents";
import {
  AgentId,
  type MemoryActor,
  type MemoryChanged,
  MemoryPath,
  type MemoryScope,
  memoryProjectIdentity,
  memoryScopeKey,
} from "@hobbots/domain";
import { type MemoryStoreFakeControls, makeMemoryStoreFake } from "@hobbots/memory/testing";
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
import { Duration, Effect, Layer, Schedule, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { MemoryChanges } from "../src/memory.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let store: MemoryStoreShape;
let controls: MemoryStoreFakeControls;
let streamed: Array<MemoryChanged>;

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-000000000021");
const site = memoryProjectIdentity("git@github.com:me/site.git", "site");
const asPip: MemoryActor = { _tag: "Hob", agentId: pip, projects: [site] };
const you: MemoryActor = { _tag: "You" };
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: pip };
const theSite: MemoryScope = { _tag: "Project", identity: site };
const everyone: MemoryScope = { _tag: "Everyone" };
const fresh = { _tag: "New" } as const;
const draft = (path: string, markdown: string) => ({ path: MemoryPath.make(path), markdown, tags: [], pinned: false });

// The whole API over a test database and the fake memory, whose watch looks every 20 milliseconds.
beforeEach(() => {
  const fake = makeMemoryStoreFake();
  store = fake.store;
  controls = fake.controls;
  streamed = [];
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
  const Streamed = Layer.effectDiscard(
    EventBus.use((bus) =>
      bus.stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "Transient" && event.event._tag === "MemoryChanged") streamed.push(event.event);
          }),
        ),
        Effect.forkScoped,
      ),
    ),
  );
  const App = HobLifecycle.layer
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
          ApprovalService.layer,
          GrantService.layer,
          HobService.layer,
          PermissionSummary.layer,
          MemoryChanges.layer(Duration.millis(20)).pipe(Layer.provideMerge(Layer.succeed(MemoryStore, store))),
          Streamed,
        ),
      ),
    )
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Persistence,
          EventBus.layer,
          HobAdmission.layer,
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

const get = async (path: string) => {
  const response = await handler(new Request(`http://localhost:4317${path}`, { headers: AS_WINDOW }));
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

const write = (actor: MemoryActor, scope: MemoryScope, path: string, markdown: string) =>
  Effect.runPromise(store.write(actor, scope, draft(path, markdown), fresh));

/** Waits until `check` holds, as a client waits for the stream. */
const eventually = (check: () => boolean) =>
  Effect.runPromise(
    Effect.suspend(() => (check() ? Effect.void : Effect.fail("waiting"))).pipe(
      Effect.retry(Schedule.spaced("10 millis")),
      Effect.timeout("3 seconds"),
    ),
  );

describe("the Memory page's API", () => {
  // covers ADR 028 (Browse), #958
  it("[TC-GEN-235] lists every scope with its count, a scope's pages, and a page with its history", async () => {
    await write(asPip, pipsOwn, "howtos/preview.md", "# Publishing a preview link\n\nAsk Ada.");
    await write(asPip, theSite, "facts/plan.md", "# The annual plan costs $10 a month");
    await write(you, everyone, "rules/ask.md", "# Ask before emailing");

    const overview = await get("/api/memory");
    expect(overview.status).toBe(200);
    expect(overview.body.scopes).toHaveLength(3);
    expect(overview.body.scopes).toContainEqual({ scope: pipsOwn, pages: 1 });

    const pages = await get(`/api/memory/pages?${query({ scope: memoryScopeKey(theSite) })}`);
    expect(pages.body).toEqual([
      expect.objectContaining({ path: "facts/plan.md", title: "The annual plan costs $10 a month" }),
    ]);

    const read = await get(`/api/memory/page?${query({ scope: memoryScopeKey(pipsOwn), path: "howtos/preview.md" })}`);
    expect(read.status).toBe(200);
    expect(read.body.page).toMatchObject({
      markdown: "# Publishing a preview link\n\nAsk Ada.",
      author: { _tag: "Hob", agentId: pip },
    });
    expect(read.body.history).toHaveLength(1);

    const missing = await get(`/api/memory/page?${query({ scope: memoryScopeKey(pipsOwn), path: "howtos/none.md" })}`);
    expect(missing.status).toBe(404);
    expect((await get(`/api/memory/pages?${query({ scope: "nowhere" })}`)).status).toBe(400);
  });

  // covers ADR 028 (Browse), #958
  it("[TC-GEN-236] reads an earlier version of a page, and searches one scope or all of them", async () => {
    const first = await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("howtos/preview.md", "# Preview\n\nAsk Ada."), fresh),
    );
    await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("howtos/preview.md", "# Preview\n\nAsk Ada for a preview link."), {
        _tag: "Version",
        version: first,
      }),
    );
    await write(you, everyone, "rules/preview.md", "# Share a preview only with you");

    const old = await get(
      `/api/memory/version?${query({ scope: memoryScopeKey(pipsOwn), path: "howtos/preview.md", version: first })}`,
    );
    expect(old.body).toMatchObject({ version: first, markdown: "# Preview\n\nAsk Ada." });
    expect(
      (
        await get(
          `/api/memory/version?${query({ scope: memoryScopeKey(pipsOwn), path: "howtos/preview.md", version: "v404" })}`,
        )
      ).status,
    ).toBe(404);

    expect((await get(`/api/memory/search?${query({ q: "preview" })}`)).body).toHaveLength(2);
    const inOne = await get(`/api/memory/search?${query({ q: "preview", scope: "everyone" })}`);
    expect(inOne.body).toEqual([expect.objectContaining({ path: "rules/preview.md" })]);
  });

  // covers ADR 028 (When memory is down), #958
  it("[TC-GEN-237] answers 503, never an empty memory, while memory does not answer", async () => {
    await write(asPip, pipsOwn, "howtos/preview.md", "# Preview");
    controls.setDown(true);
    for (const path of ["/api/memory", "/api/memory/changes", `/api/memory/search?${query({ q: "preview" })}`]) {
      const answer = await get(path);
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ _tag: "MemoryNotAnswering" });
    }
    controls.setDown(false);
    expect((await get("/api/memory")).status).toBe(200);
  });

  // covers ADR 028 (What changed), #958
  it("[TC-GEN-238] streams a hob's save to What changed once the hub looks", async () => {
    // The hub starts with its first request; its watch looks from then on.
    expect((await get("/api/memory/changes")).body).toEqual([]);
    await write(asPip, pipsOwn, "howtos/preview.md", "# Publishing a preview link");
    await eventually(() =>
      streamed.some((event) => event.changes.some((change) => change.path === "howtos/preview.md")),
    );
    const changes = await get("/api/memory/changes");
    expect(changes.body).toEqual([
      expect.objectContaining({ path: "howtos/preview.md", author: { _tag: "Hob", agentId: pip } }),
    ]);
    // A later save streams on its own, once.
    await write(asPip, pipsOwn, "gotchas/link.md", "# The link must exist before the email");
    await eventually(() => streamed.some((event) => event.changes.some((change) => change.path === "gotchas/link.md")));
    const all = streamed.flatMap((event) => event.changes).map((change) => change.path);
    expect(all.filter((path) => path === "howtos/preview.md")).toHaveLength(1);
    expect((await get("/api/memory/changes")).body.map((change: { path: string }) => change.path)).toEqual([
      "gotchas/link.md",
      "howtos/preview.md",
    ]);
  });
});
