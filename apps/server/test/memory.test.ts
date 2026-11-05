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

    const overview = await get("/api/memory/scopes");
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
  it("[TC-GEN-236] reads what a version of a page changed, and searches one scope or all of them", async () => {
    const first = await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("howtos/preview.md", "# Preview\n\nAsk Ada."), fresh),
    );
    const second = await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("howtos/preview.md", "# Preview\n\nAsk Ada for a preview link."), {
        _tag: "Version",
        version: first,
      }),
    );
    await write(you, everyone, "rules/preview.md", "# Share a preview only with you");

    const changed = await get(
      `/api/memory/version?${query({ scope: memoryScopeKey(pipsOwn), path: "howtos/preview.md", version: second })}`,
    );
    expect(changed.body).toEqual({
      first: false,
      cut: false,
      lines: [
        { op: "same", text: "# Preview" },
        { op: "same", text: "" },
        { op: "remove", text: "Ask Ada." },
        { op: "add", text: "Ask Ada for a preview link." },
      ],
    });
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
    for (const path of ["/api/memory/scopes", "/api/memory/changes", `/api/memory/search?${query({ q: "preview" })}`]) {
      const answer = await get(path);
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ _tag: "MemoryNotAnswering" });
    }
    controls.setDown(false);
    expect((await get("/api/memory/scopes")).status).toBe(200);
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

const post = async (path: string, body: unknown) => {
  const response = await handler(
    new Request(`http://localhost:4317${path}`, {
      method: "POST",
      headers: { ...AS_WINDOW, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};

/** What the Memory page sends to save a page as you. */
const saved = (scope: MemoryScope, path: string, markdown: string, more: Record<string, unknown> = {}) => ({
  scope: memoryScopeKey(scope),
  path,
  markdown,
  tags: [],
  pinned: false,
  forgetOn: null,
  expected: null,
  ...more,
});

const readPage = (scope: MemoryScope, path: string) =>
  get(`/api/memory/page?${query({ scope: memoryScopeKey(scope), path })}`);

describe("changing memory from the Memory page", () => {
  // covers ADR 028 (Writes), #959
  it("[TC-GEN-334] saves an edit as a new version by you, and restores the hob's version as another", async () => {
    const learned = await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("howtos/preview.md", "# Preview\n\nAsk Ada."), fresh),
    );
    const edit = await post(
      "/api/memory/page",
      saved(pipsOwn, "howtos/preview.md", "# Preview\n\nAsk Ada for a preview link.", { expected: learned }),
    );
    expect(edit.status).toBe(200);
    expect(edit.body.page).toMatchObject({ markdown: "# Preview\n\nAsk Ada for a preview link.", author: you });
    expect(edit.body.history.map((entry: { version: string }) => entry.version)).toEqual([
      edit.body.page.version,
      learned,
    ]);
    // What changed lists your edit without waiting for the next look.
    expect((await get("/api/memory/changes")).body).toContainEqual(
      expect.objectContaining({ path: "howtos/preview.md", version: edit.body.page.version, author: you }),
    );

    const restored = await post("/api/memory/page/restore", {
      scope: memoryScopeKey(pipsOwn),
      path: "howtos/preview.md",
      version: learned,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.page).toMatchObject({ markdown: "# Preview\n\nAsk Ada.", author: you });
    expect(restored.body.history).toHaveLength(3);
    expect(restored.body.history[0]).toMatchObject({ latest: true, author: you });
  });

  // covers ADR 028 (Writes), #959
  it("[TC-GEN-335] pins a page and sets the day it is forgotten, each as a version History can restore", async () => {
    const learned = await Effect.runPromise(store.write(asPip, theSite, draft("facts/plan.md", "# Plan"), fresh));
    const pinned = await post(
      "/api/memory/page",
      saved(theSite, "facts/plan.md", "# Plan", { pinned: true, expected: learned }),
    );
    expect(pinned.body.page).toMatchObject({ pinned: true, forgetOn: null, author: you });
    const forget = await post(
      "/api/memory/page",
      saved(theSite, "facts/plan.md", "# Plan", {
        pinned: true,
        forgetOn: "2099-12-31",
        expected: pinned.body.page.version,
      }),
    );
    expect(forget.body.page).toMatchObject({ pinned: true, forgetOn: "2099-12-31" });
    expect(forget.body.history).toHaveLength(3);
    // Restoring the version before the forget day keeps the page.
    const kept = await post("/api/memory/page/restore", {
      scope: memoryScopeKey(theSite),
      path: "facts/plan.md",
      version: pinned.body.page.version,
    });
    expect(kept.body.page).toMatchObject({ pinned: true, forgetOn: null, author: you });
    // A day that is not one is refused before memory is reached.
    const wrong = await post("/api/memory/page", saved(theSite, "facts/plan.md", "# Plan", { forgetOn: "soon" }));
    expect(wrong.status).toBe(400);
  });

  // covers ADR 028 (Writes), #959
  it("[TC-GEN-336] deletes a page with its history, streams the delete to every client, and Undo brings it back as a version by you", async () => {
    const learned = await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("gotchas/link.md", "# Link first"), fresh),
    );
    const deleted = await post("/api/memory/page/delete", {
      scope: memoryScopeKey(pipsOwn),
      path: "gotchas/link.md",
      version: learned,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.restoreFrom).not.toBeNull();
    expect((await readPage(pipsOwn, "gotchas/link.md")).status).toBe(404);
    // Every client hears of the delete at once, though no look at memory can find a page that is gone.
    await eventually(() =>
      streamed.some((event) => event.deleted?.some((page) => page.path === "gotchas/link.md") === true),
    );
    expect(streamed.find((event) => event.deleted !== undefined)?.deleted).toEqual([
      { scope: pipsOwn, path: "gotchas/link.md" },
    ]);
    const undone = await post("/api/memory/page/restore", {
      scope: memoryScopeKey(pipsOwn),
      path: "gotchas/link.md",
      version: deleted.body.restoreFrom,
    });
    expect(undone.status).toBe(200);
    expect(undone.body.page).toMatchObject({ markdown: "# Link first", author: you });
  });

  // covers ADR 028 (MemoryConflict), #959
  it("[TC-GEN-337] refuses an edit, a pin or a delete that races a hob's save, and writes nothing", async () => {
    const opened = await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("howtos/tests.md", "# Tests\n\nRun pnpm check."), fresh),
    );
    // Pip saves the page while you have it open in the editor.
    const hobs = await Effect.runPromise(
      store.write(asPip, pipsOwn, draft("howtos/tests.md", "# Tests\n\nRun pnpm check, then pnpm test:pg."), {
        _tag: "Version",
        version: opened,
      }),
    );
    for (const [path, body] of [
      ["/api/memory/page", saved(pipsOwn, "howtos/tests.md", "# Tests\n\nRun pnpm test.", { expected: opened })],
      [
        "/api/memory/page",
        saved(pipsOwn, "howtos/tests.md", "# Tests\n\nRun pnpm check.", { pinned: true, expected: opened }),
      ],
      ["/api/memory/page/delete", { scope: memoryScopeKey(pipsOwn), path: "howtos/tests.md", version: opened }],
    ] as const) {
      const refused = await post(path, body);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ _tag: "MemoryPageChanged", path: "howtos/tests.md", current: hobs });
    }
    const page = await readPage(pipsOwn, "howtos/tests.md");
    expect(page.body.page).toMatchObject({ version: hobs, author: { _tag: "Hob", agentId: pip }, pinned: false });
    expect(page.body.history).toHaveLength(2);
    // Saved again over the version it now knows, your edit goes through.
    const over = await post(
      "/api/memory/page",
      saved(pipsOwn, "howtos/tests.md", "# Tests\n\nRun pnpm test.", { expected: hobs }),
    );
    expect(over.status).toBe(200);
    expect(over.body.page).toMatchObject({ markdown: "# Tests\n\nRun pnpm test.", author: you });
    // A new page never replaces one already at its path.
    const taken = await post("/api/memory/page", saved(pipsOwn, "howtos/tests.md", "# Tests again"));
    expect(taken.status).toBe(409);
  });

  // covers ADR 028 (Sharing: About you), #959
  it("[TC-GEN-338] writes About you, which every hob reads, as your own pages", async () => {
    const added = await post(
      "/api/memory/page",
      saved(everyone, "rules/short-emails.md", "# Keep customer emails short"),
    );
    expect(added.status).toBe(200);
    expect(added.body.page).toMatchObject({ scope: everyone, author: you });
    const about = await get(`/api/memory/pages?${query({ scope: "everyone" })}`);
    expect(about.body).toEqual([
      expect.objectContaining({ path: "rules/short-emails.md", title: "Keep customer emails short" }),
    ]);
    // Every hob finds it.
    expect(await Effect.runPromise(store.search(asPip, [pipsOwn, everyone], "customer emails", 10))).toEqual([
      expect.objectContaining({ path: "rules/short-emails.md" }),
    ]);
    controls.setDown(true);
    const down = await post("/api/memory/page", saved(everyone, "rules/later.md", "# Later"));
    expect(down.status).toBe(503);
  });
});
