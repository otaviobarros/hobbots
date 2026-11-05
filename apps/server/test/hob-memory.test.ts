import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  HobTools,
  MemorySaves,
  MemoryStore,
  type MemoryStoreShape,
  PermissionSummary,
  undoMemorySave,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type EventEnvelope,
  type MemoryActor,
  MemoryPath,
  MemorySave,
  type MemoryScope,
  MessageId,
  memoryProjectIdentity,
  ThreadId,
} from "@hobbots/domain";
import { type MemoryStoreFakeControls, makeMemoryStoreFake } from "@hobbots/memory/testing";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  MemorySavesLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Memory in a chat and on a hob's page (ADR 028, #961), over a test database and the fake memory.

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let store: MemoryStoreShape;
let controls: MemoryStoreFakeControls;
let saves: MemorySaves["Service"];
let journaled: Array<EventEnvelope>;
let folder = "";

const pip = AgentId.make("0d6e2f0a-0000-4000-8000-000000000031");
const thread = ThreadId.make("thread-1");
const reply = MessageId.make("reply-1");
const asPip: MemoryActor = { _tag: "Hob", agentId: pip, projects: [] };
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: pip };
const path = MemoryPath.make("decisions/tuesday.md");
const now = "2026-11-05T09:55:00.000Z";

beforeEach(() => {
  const fake = makeMemoryStoreFake();
  store = fake.store;
  controls = fake.controls;
  journaled = [];
  // The hob works in a folder named `site`, so it reads the `site` project.
  folder = join(mkdtempSync(join(tmpdir(), "hob-memory-")), "site");
  mkdirSync(folder);
  const Persistence = Layer.mergeAll(
    HobbotsRepositoryLive,
    ApprovalRepositoryLive,
    GrantRepositoryLive,
    TaskRepositoryLive,
    EventJournal.layer,
    BackpackLive,
    SetupRepository.layer,
    SearchIndex.layer,
    MemorySavesLive,
  ).pipe(Layer.provideMerge(TestDatabase));
  // The hob Pip, and the test's hands on the record of saves and on what the hub announces.
  const Seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      saves = yield* MemorySaves;
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(
        new Agent({
          id: pip,
          name: "Pip",
          roleTitle: "Writer",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 1,
          lookColor: "moss",
          configVersion: 1,
          createdAt: now,
          policy: { ownFolders: [folder], hiddenSharedFolders: [], overrides: {} },
        }),
      );
      const bus = yield* EventBus;
      yield* bus.stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "Journaled") journaled.push(event.entry);
          }),
        ),
        Effect.forkScoped,
      );
    }),
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
          Layer.succeed(MemoryStore, store),
          Seeded,
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
afterEach(async () => {
  await dispose();
  rmSync(join(folder, ".."), { recursive: true, force: true });
});

const request = async (method: string, url: string) => {
  const response = await handler(new Request(`http://localhost:4317${url}`, { method, headers: AS_WINDOW }));
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};
const get = (url: string) => request("GET", url);
const undo = (id: string) => request("POST", `/api/memory-saves/${id}/undo`);

const page = (markdown: string) => ({ path, markdown, tags: [], pinned: false });

/** A save Pip made from `messageId` in `threadId`, recorded and, unless memory is down, written and settled. */
const saved = (
  id: string,
  markdown: string,
  { threadId = thread, messageId = reply }: { threadId?: ThreadId; messageId?: MessageId } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      // The hub starts with its first request, which also inserts Pip.
      const save = new MemorySave({
        id,
        agentId: pip,
        work: `reply:${messageId}`,
        key: `${id}-key`,
        input: `${id}-input`,
        scope: pipsOwn,
        path,
        markdown,
        tags: [],
        state: "sending",
        version: null,
        threadId,
        messageId,
        createdAt: now,
        updatedAt: now,
      });
      yield* saves.begin(save);
      const version = yield* store.write(asPip, pipsOwn, page(markdown), { _tag: "Any" }).pipe(Effect.option);
      yield* saves.settle(
        save,
        version._tag === "Some" ? "saved" : "queued",
        version._tag === "Some" ? version.value : null,
        now,
      );
    }),
  );

const current = () => Effect.runPromise(store.page({ _tag: "You" }, pipsOwn, path));

describe("memory in a chat and on a hob's page", () => {
  // covers ADR 028 (The memory tools), #961
  it("[TC-GEN-341] lists the saves a thread's replies made, and only that thread's", async () => {
    await get("/api/threads/thread-1/memory-saves");
    await saved("s1", "# Launch emails go out Tuesday at 9 AM");
    await saved("s2", "# Elsewhere", { threadId: ThreadId.make("thread-2"), messageId: MessageId.make("reply-2") });

    const listed = await get("/api/threads/thread-1/memory-saves");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: "s1", messageId: "reply-1", state: "saved", path: "decisions/tuesday.md" }),
    ]);
    expect(listed.body[0]).not.toHaveProperty("undoneAt");
    expect((await get("/api/threads/thread-3/memory-saves")).body).toEqual([]);
  });

  // covers ADR 028 (Writes), #961
  it("[TC-GEN-342] Undo puts back the version a save replaced, marks it undone and announces it, once", async () => {
    await get("/api/threads/thread-1/memory-saves");
    await saved("s1", "# Launch emails go out Monday");
    await saved("s2", "# Launch emails go out Tuesday at 9 AM", { messageId: MessageId.make("reply-2") });

    const undone = await undo("s2");
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ id: "s2", state: "saved", undoneAt: expect.any(String) });
    expect((await current())?.markdown).toBe("# Launch emails go out Monday");
    expect((await current())?.author).toEqual({ _tag: "You" });
    expect(journaled.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({ _tag: "MemorySaveChanged", save: expect.objectContaining({ id: "s2" }) }),
    );
    expect((await get("/api/threads/thread-1/memory-saves")).body[1]).toMatchObject({
      id: "s2",
      undoneAt: undone.body.undoneAt,
    });

    // A second Undo changes nothing.
    const again = await undo("s2");
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ _tag: "MemorySaveNotUndoable", reason: "undone" });
    expect((await current())?.markdown).toBe("# Launch emails go out Monday");
  });

  // covers ADR 028 (Writes), #961
  it("[TC-GEN-343] Undo of a save that made a page removes the page", async () => {
    await get("/api/threads/thread-1/memory-saves");
    await saved("s1", "# Launch emails go out Tuesday at 9 AM");
    expect((await undo("s1")).status).toBe(200);
    expect(await current()).toBeNull();
  });

  // covers ADR 028 (Writes, When memory is down), #961
  it("[TC-GEN-344] refuses Undo after a newer version, before memory has the save, and while memory is down", async () => {
    await get("/api/threads/thread-1/memory-saves");
    await saved("s1", "# Launch emails go out Tuesday at 9 AM");
    // You changed the page after the save: Undo would throw that away.
    await Effect.runPromise(
      store.write({ _tag: "You" }, pipsOwn, page("# Launch emails go out Wednesday"), { _tag: "Any" }),
    );
    expect((await undo("s1")).body).toMatchObject({ _tag: "MemorySaveNotUndoable", reason: "newer" });
    expect((await current())?.markdown).toBe("# Launch emails go out Wednesday");

    expect((await undo("nothing")).status).toBe(404);

    controls.setDown(true);
    await saved("s2", "# Kept for later", { messageId: MessageId.make("reply-2") });
    expect((await undo("s2")).body).toMatchObject({ _tag: "MemorySaveNotUndoable", reason: "not-saved" });
    controls.setDown(false);
    await saved("s3", "# Launch emails go out Thursday", { messageId: MessageId.make("reply-3") });
    controls.setDown(true);
    const down = await undo("s3");
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ _tag: "MemoryNotAnswering" });
    controls.setDown(false);
    expect((await undo("s3")).status).toBe(200);
  });

  // covers ADR 028 (Writes), #961
  it("[TC-GEN-347] refuses Undo when a change lands after it read the page's history, and keeps that change", async () => {
    await get("/api/threads/thread-1/memory-saves");
    await saved("s1", "# Launch emails go out Monday");
    await saved("s2", "# Launch emails go out Tuesday at 9 AM", { messageId: MessageId.make("reply-2") });
    // You change the page just after Undo has checked that the save is still its latest version.
    const racing: MemoryStoreShape = {
      ...store,
      history: (actor, scope, at) =>
        Effect.tap(store.history(actor, scope, at), () =>
          store
            .write({ _tag: "You" }, scope, page("# Launch emails go out Wednesday"), { _tag: "Any" })
            .pipe(Effect.orDie),
        ),
    };
    const refused = await Effect.runPromise(Effect.flip(undoMemorySave(racing, saves, "s2", now)));
    expect(refused).toMatchObject({ _tag: "MemoryUndoRefused", reason: "newer" });
    expect((await current())?.markdown).toBe("# Launch emails go out Wednesday");
    expect((await get("/api/threads/thread-1/memory-saves")).body[1]).not.toHaveProperty("undoneAt");
  });

  // covers ADR 028 (Scopes), #961
  it("[TC-GEN-345] answers what a hob reads: its own memory, About you and the projects of its folders", async () => {
    await get("/api/threads/thread-1/memory-saves");
    await saved("s1", "# Launch emails go out Tuesday at 9 AM");
    const site: MemoryScope = { _tag: "Project", identity: memoryProjectIdentity(null, "site") };
    await Effect.runPromise(
      store.write(
        { _tag: "You" },
        site,
        { ...page("# Publish with pnpm deploy"), path: MemoryPath.make("howtos/publish.md") },
        {
          _tag: "New",
        },
      ),
    );
    const read = await get(`/api/agents/${pip}/memory`);
    expect(read.status).toBe(200);
    expect(read.body.scopes).toEqual([
      { scope: pipsOwn, pages: 1 },
      { scope: { _tag: "Everyone" }, pages: 0 },
      { scope: site, pages: 1 },
    ]);
    expect((await get("/api/agents/0d6e2f0a-0000-4000-8000-000000000099/memory")).status).toBe(404);
    controls.setDown(true);
    expect((await get(`/api/agents/${pip}/memory`)).status).toBe(503);
  });
});
