import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  type CharmTurn,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  HobTools,
  MemoryProjects,
  MemoryReviews,
  MemorySaves,
  MemorySharesLive,
  MemoryStore,
  type MemoryStoreShape,
  MemoryTools,
  makeRedactor,
  PermissionSummary,
  type ToolAccess,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  type EventEnvelope,
  MEMORY_SAVE_TOOL,
  type MemoryActor,
  MemoryPath,
  type MemoryScope,
  type MemoryShare,
  MemoryUnavailable,
  memoryProjectIdentity,
  type SafetyPreset,
} from "@hobbots/domain";
import { MemoryToolsLive } from "@hobbots/memory";
import { type MemoryStoreFakeControls, makeMemorySavesFake, makeMemoryStoreFake } from "@hobbots/memory/testing";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  MemoryShareLogLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #960: what hobs want to share (ADR 028, Sharing), from the hob's `memory_save` to your decision over
// HTTP, on the hub's database and the fake memory. The preset decides whether a share waits for you;
// About you asks under every preset.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hobbots-memory-shares-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ada = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000a1");
const siteFolder = path.join(root, "site");
fs.mkdirSync(siteFolder, { recursive: true });
const site = memoryProjectIdentity("git@github.com:me/site.git", "site");
const theSite: MemoryScope = { _tag: "Project", identity: site };
const everyone: MemoryScope = { _tag: "Everyone" };
const adasOwn: MemoryScope = { _tag: "Hob", agentId: ada };
const you: MemoryActor = { _tag: "You" };
const PAGE = MemoryPath.make("howto/deploy.md");
const MARKDOWN = "# Deploy\n\nRun `pnpm deploy` from the repository root.";

const App = (store: MemoryStoreShape) => {
  const Persistence = Layer.mergeAll(
    HobbotsRepositoryLive,
    ApprovalRepositoryLive,
    GrantRepositoryLive,
    TaskRepositoryLive,
    EventJournal.layer,
    BackpackLive,
    SetupRepository.layer,
    SearchIndex.layer,
    MemoryShareLogLive,
  ).pipe(Layer.provideMerge(TestDatabase));
  const Memory = MemoryToolsLive.pipe(
    Layer.provideMerge(MemorySharesLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(MemoryStore, store),
        Layer.succeed(MemorySaves, makeMemorySavesFake().service),
        Layer.succeed(MemoryProjects, {
          of: (folder: string) =>
            Effect.succeed(memoryProjectIdentity(folder === siteFolder ? "git@github.com:me/site.git" : null, "x")),
        }),
        PolicyEngine.node,
      ),
    ),
  );
  return HobLifecycle.layer
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
          ApprovalService.layer,
          GrantService.layer,
          HobService.layer,
          PermissionSummary.layer,
          Memory,
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
};

type AppLayer = ReturnType<typeof App>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<AppLayer>, Layer.Error<AppLayer>>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let store: MemoryStoreShape;
let controls: MemoryStoreFakeControls;
/**
 * Calls whose next try fails as if memory were down: `before` memory takes it, or `after`, when the
 * answer is lost although the call landed, as when the hub stops or the link drops. An effect runs
 * just before the call reaches memory, as a change landing meanwhile would.
 */
let cut: Map<"write" | "forget" | "restore", "before" | "after" | Effect.Effect<unknown, unknown>>;
/** How many more times memory answers no version's text whole, as when its diff is cut short. */
let textCut = 0;

/**
 * The fake memory, with the calls named in `cut` cut short, and a history that names an author only
 * for the latest version, as ai-memory's does.
 */
const cutting = (inner: MemoryStoreShape): MemoryStoreShape => {
  const down = () => Effect.fail(new MemoryUnavailable({ message: "Memory went away." }));
  const call = <A, E>(name: "write" | "forget" | "restore", effect: Effect.Effect<A, E>) => {
    const when = cut.get(name);
    cut.delete(name);
    if (when === "before") return down();
    if (when === "after") return Effect.flatMap(effect, down);
    return when === undefined ? effect : Effect.andThen(Effect.orDie(when), effect);
  };
  return {
    ...inner,
    versionText: (actor, scope, at, version, known) =>
      Effect.suspend(() => {
        if (textCut === 0) return inner.versionText(actor, scope, at, version, known);
        textCut -= 1;
        return Effect.succeed(null);
      }),
    history: (actor, scope, at) =>
      Effect.map(inner.history(actor, scope, at), (versions) =>
        versions.map((each) => (each.latest ? each : { ...each, author: null })),
      ),
    write: (actor, scope, draft, expected) =>
      Effect.suspend(() => call("write", inner.write(actor, scope, draft, expected))),
    forget: (actor, scope, at, expected) =>
      Effect.suspend(() => call("forget", inner.forget(actor, scope, at, expected))),
    restore: (actor, scope, at, version, expected) =>
      Effect.suspend(() => call("restore", inner.restore(actor, scope, at, version, expected))),
  };
};

beforeEach(async () => {
  const fake = makeMemoryStoreFake();
  cut = new Map();
  textCut = 0;
  store = cutting(fake.store);
  controls = fake.controls;
  runtime = ManagedRuntime.make(App(store));
  await runtime.runPromise(
    HobbotsRepository.use((repo) =>
      repo.insertAgent(
        new Agent({
          id: ada,
          name: "Ada",
          roleTitle: "Builder",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 4821,
          lookColor: "violet",
          configVersion: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ),
  );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provideMerge(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = async () => {
    await web.dispose();
    await runtime.dispose();
  };
});
afterEach(() => dispose());

const request = async <A>(method: string, route: string, body?: unknown) => {
  const response = await handler(
    new Request(`http://localhost:4317${route}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as A };
};

const accessFor = (preset: SafetyPreset): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, ownFolders: [siteFolder], overrides: {} },
    dataFolder: path.join(root, "data"),
    restrictions: [],
  },
  folders: [siteFolder],
  runtimeFolder: path.join(root, "runtimes", "ada"),
});

/** Ada saves the deploy how-to to `scope` under `preset`, in a turn of its own. */
const save = (
  preset: SafetyPreset,
  scope: "project" | "everyone",
  options: { key?: string; work?: string; markdown?: string } = {},
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const turn: CharmTurn = {
        agentId: ada,
        threadId: null,
        messageId: null,
        scope: () => options.work ?? "reply:m1",
        also: options.work ?? "reply:m1",
        currentAccess: Effect.succeed(accessFor(preset)),
        redactor: makeRedactor([]),
        approvals: null,
      };
      const tools = yield* (yield* MemoryTools).forTurn(turn);
      if (tools === null) throw new Error("No memory tools");
      return yield* tools.call(
        MEMORY_SAVE_TOOL,
        { key: options.key ?? "deploy", scope, path: PAGE, markdown: options.markdown ?? MARKDOWN, tags: ["deploy"] },
        { id: "step-1", report: () => undefined },
      );
    }),
  );

const shares = async () => (await request<{ shares: Array<MemoryShare> }>("GET", "/api/memory/shares")).body.shares;
const page = (scope: MemoryScope) => Effect.runPromise(store.page(you, scope, PAGE));
/** The kinds of the journal's share entries, in order. */
const journal = async () =>
  ((await runtime.runPromise(EventJournal.use((events) => events.readAfter(0, 500)))) as ReadonlyArray<EventEnvelope>)
    .map((entry) => entry.type)
    .filter((type) => type.startsWith("MemoryShare"));

describe("what hobs want to share", () => {
  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-360] waits for you under Careful and Balanced, and writes nothing until you decide", async () => {
    for (const preset of ["careful", "balanced"] as const) {
      const answer = await save(preset, "project", { key: `deploy-${preset}`, work: `reply:${preset}` });
      expect(answer).toEqual({
        text: `Asked the user to share ${PAGE} with the project ${site}. It waits for their review in the Inbox, so it is not shared yet. Do not save it again.`,
        refused: false,
      });
    }
    const waiting = await shares();
    expect(waiting.map((share) => [share.state, share.through, share.scope])).toEqual([
      ["waiting", "review", theSite],
      ["waiting", "review", theSite],
    ]);
    expect(await page(theSite)).toBeNull();
    expect(await journal()).toEqual(["MemoryShareRequested", "MemoryShareRequested"]);
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-361] lets a share to a project through under Trusting, written as the hob, with Undo", async () => {
    const answer = await save("trusting", "project");
    expect(answer).toEqual({
      text: `Shared ${PAGE} with the project ${site}. The user can see it in Memory and undo it.`,
      refused: false,
    });
    const [shared] = await shares();
    expect(shared).toMatchObject({ state: "shared", through: "preset", previous: null });
    const written = await page(theSite);
    expect(written).toMatchObject({ markdown: MARKDOWN, author: { _tag: "Hob", agentId: ada } });
    expect(shared?.version).toBe(written?.version);
    expect(await journal()).toEqual(["MemoryShareRequested", "MemoryShareChanged"]);
    // Undo takes the page out of the project, and leaves it in Ada's own memory.
    const undone = await request<MemoryShare>("POST", `/api/memory/shares/${shared?.id}/undo`);
    expect(undone).toMatchObject({ status: 200, body: { state: "undone" } });
    expect(await page(theSite)).toBeNull();
    expect(await page(adasOwn)).toMatchObject({ markdown: MARKDOWN });
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-362] asks you before a share with every hob under every preset, Trusting included", async () => {
    for (const preset of ["careful", "balanced", "trusting"] as const) {
      const answer = await save(preset, "everyone", { key: `about-${preset}`, work: `reply:${preset}` });
      expect(answer.text).toBe(
        `Asked the user to share ${PAGE} with every hob (About you). It waits for their review in the Inbox, so it is not shared yet. Do not save it again.`,
      );
    }
    expect((await shares()).map((share) => [share.state, share.through])).toEqual([
      ["waiting", "review"],
      ["waiting", "review"],
      ["waiting", "review"],
    ]);
    expect(await page(everyone)).toBeNull();
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-363] records a retried key once, and answers it as the share now stands", async () => {
    await save("balanced", "project");
    const again = await save("balanced", "project");
    expect(again.text).toContain("It waits for their review");
    expect(await shares()).toHaveLength(1);
    const [waiting] = await shares();
    await request("POST", `/api/memory/shares/${waiting?.id}/keep`);
    expect((await save("balanced", "project")).text).toBe(
      `The user kept ${PAGE} private, so it is in your own memory only.`,
    );
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-364] leaves a share to you under Trusting while memory does not answer", async () => {
    controls.setDown(true);
    const answer = await save("trusting", "project");
    controls.setDown(false);
    expect(answer.text).toContain("It waits for their review");
    expect((await shares()).map((share) => [share.state, share.through])).toEqual([["waiting", "review"]]);
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-365] shares it as the hob wrote it, written as the hob, and you as the one who approved it", async () => {
    await save("balanced", "project");
    const [waiting] = await shares();
    const shared = await request<MemoryShare>("POST", `/api/memory/shares/${waiting?.id}/share`, {});
    expect(shared).toMatchObject({ status: 200, body: { state: "shared", through: "review", edited: false } });
    expect(shared.body.decidedAt).not.toBeNull();
    expect(await page(theSite)).toMatchObject({ markdown: MARKDOWN, author: { _tag: "Hob", agentId: ada } });
    // Decided once: a second decision is refused, and nothing is written again.
    const twice = await request<{ _tag: string; state: string }>("POST", `/api/memory/shares/${waiting?.id}/keep`);
    expect(twice).toMatchObject({ status: 409, body: { _tag: "MemoryShareClosed", state: "shared" } });
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-366] shares your edit, still as the hob, and marks it edited", async () => {
    await save("careful", "everyone");
    const [waiting] = await shares();
    const edited = "# Deploy\n\nRun `pnpm deploy:prod` from the repository root.";
    const shared = await request<MemoryShare>("POST", `/api/memory/shares/${waiting?.id}/share`, {
      markdown: edited,
    });
    expect(shared).toMatchObject({ status: 200, body: { state: "shared", edited: true, markdown: edited } });
    expect(await page(everyone)).toMatchObject({ markdown: edited, author: { _tag: "Hob", agentId: ada } });
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-367] keeps it private in the hob's own memory, and never in the shared one", async () => {
    await save("balanced", "project");
    const [waiting] = await shares();
    const kept = await request<MemoryShare>("POST", `/api/memory/shares/${waiting?.id}/keep`);
    expect(kept).toMatchObject({ status: 200, body: { state: "kept" } });
    expect(await page(theSite)).toBeNull();
    expect(await page(adasOwn)).toMatchObject({ markdown: MARKDOWN, author: { _tag: "Hob", agentId: ada } });
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-368] undoes an approved share back to the page it replaced, and never over a later change", async () => {
    await Effect.runPromise(
      store.write(
        you,
        theSite,
        { path: PAGE, markdown: "# Deploy\n\nAsk Bram.", tags: [], pinned: false },
        {
          _tag: "New",
        },
      ),
    );
    await save("balanced", "project");
    const [waiting] = await shares();
    await request("POST", `/api/memory/shares/${waiting?.id}/share`, {});
    expect(await page(theSite)).toMatchObject({ markdown: MARKDOWN });
    await request("POST", `/api/memory/shares/${waiting?.id}/undo`);
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nAsk Bram." });

    // Shared again, then changed by you: Undo leaves your change alone.
    await save("trusting", "project", { key: "deploy-2", work: "reply:m2" });
    const later = (await shares()).find((share) => share.state === "shared");
    const current = await page(theSite);
    await Effect.runPromise(
      store.write(
        you,
        theSite,
        { path: PAGE, markdown: "# Deploy\n\nYours.", tags: [], pinned: false },
        {
          _tag: "Version",
          version: current?.version ?? ("" as never),
        },
      ),
    );
    const refused = await request<{ _tag: string }>("POST", `/api/memory/shares/${later?.id}/undo`);
    expect(refused).toMatchObject({ status: 409, body: { _tag: "MemoryShareChangedMeanwhile" } });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nYours." });
  });

  // covers ADR 028 (Sharing), PE-006, #960
  it("[TC-GEN-369] takes a decision only from you, never from a hob's turn", async () => {
    await save("balanced", "project");
    const [waiting] = await shares();
    // Without a user session, as from a hob, Charm or runtime tool, the decision does not run.
    const exit = await runtime.runPromiseExit(
      MemoryReviews.use(
        (reviews) => reviews.share(waiting?.id ?? "", undefined) as Effect.Effect<MemoryShare, unknown, never>,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect((await shares())[0]?.state).toBe("waiting");
    expect(await page(theSite)).toBeNull();
    // Without the window's key, the hub refuses it.
    const response = await handler(
      new Request(`http://localhost:4317/api/memory/shares/${waiting?.id}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("a share cut short", () => {
  const recover = () => runtime.runPromise(MemoryReviews.use((reviews) => reviews.recover));

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-374] finishes a share memory took while its answer was lost, and never offers it back to keep private", async () => {
    await save("balanced", "project");
    const [waiting] = await shares();
    cut.set("write", "after");
    const answer = await request<{ _tag: string }>("POST", `/api/memory/shares/${waiting?.id}/share`, {});
    expect(answer).toMatchObject({ status: 503, body: { _tag: "MemoryNotAnswering" } });
    // The page landed, so the share stays under way, not back in review where Keep private would strand it.
    expect((await shares())[0]).toMatchObject({ state: "sending", pending: "share" });
    const kept = await request<{ _tag: string }>("POST", `/api/memory/shares/${waiting?.id}/keep`);
    expect(kept).toMatchObject({ status: 409, body: { _tag: "MemoryShareClosed", state: "sending" } });
    await recover();
    const written = await page(theSite);
    expect((await shares())[0]).toMatchObject({ state: "shared", pending: null, version: written?.version });
    // Finished from what landed: the hob's page was written once.
    expect(await Effect.runPromise(store.history(you, theSite, PAGE))).toHaveLength(1);
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-375] writes a share memory never took once memory answers again", async () => {
    await save("balanced", "project");
    const [waiting] = await shares();
    // Memory goes away between the claim and the write: the page is never written.
    cut.set("write", "before");
    expect((await request("POST", `/api/memory/shares/${waiting?.id}/share`, {})).status).toBe(503);
    expect(await page(theSite)).toBeNull();
    await recover();
    expect((await shares())[0]).toMatchObject({ state: "shared" });
    expect(await page(theSite)).toMatchObject({ markdown: MARKDOWN, author: { _tag: "Hob", agentId: ada } });
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-376] resumes an Undo cut short, back to the page it replaced and into the hob's own memory", async () => {
    await Effect.runPromise(
      store.write(
        you,
        theSite,
        { path: PAGE, markdown: "# Deploy\n\nAsk Bram.", tags: [], pinned: false },
        { _tag: "New" },
      ),
    );
    await save("trusting", "project");
    const [shared] = await shares();
    cut.set("restore", "after");
    expect((await request("POST", `/api/memory/shares/${shared?.id}/undo`)).status).toBe(503);
    // Restored, but not yet in Ada's own memory, nor recorded.
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nAsk Bram." });
    expect(await page(adasOwn)).toBeNull();
    expect((await shares())[0]).toMatchObject({ state: "sending", pending: "undo" });
    await recover();
    expect((await shares())[0]).toMatchObject({ state: "undone", pending: null });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nAsk Bram." });
    expect(await page(adasOwn)).toMatchObject({ markdown: MARKDOWN });
  });
});

describe("a share cut short, then changed meanwhile", () => {
  const recover = () => runtime.runPromise(MemoryReviews.use((reviews) => reviews.recover));
  /** You change the deploy page in the shared memory, over whatever it holds now. */
  const yourEdit = (markdown: string) =>
    Effect.flatMap(store.page(you, theSite, PAGE), (current) =>
      store.write(
        you,
        theSite,
        { path: PAGE, markdown, tags: [], pinned: false },
        current === null ? { _tag: "New" } : { _tag: "Version", version: current.version },
      ),
    );

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-377] knows its own write after a later edit by what it changed, though memory names no author for it", async () => {
    await save("balanced", "project");
    const [waiting] = await shares();
    cut.set("write", "after");
    expect((await request("POST", `/api/memory/shares/${waiting?.id}/share`, {})).status).toBe(503);
    const written = await page(theSite);
    await Effect.runPromise(yourEdit("# Deploy\n\nRun `pnpm deploy`, then tell Bram."));
    await recover();
    // Shared, with the version it wrote, and your edit stays on top of it.
    expect((await shares())[0]).toMatchObject({ state: "shared", version: written?.version });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nRun `pnpm deploy`, then tell Bram." });
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-378] never takes another share by the same hob for its own, and waits for you again", async () => {
    await save("balanced", "project");
    const [first] = await shares();
    cut.set("write", "before");
    expect((await request("POST", `/api/memory/shares/${first?.id}/share`, {})).status).toBe(503);
    // Meanwhile Ada's other share of the same page goes through, over the same page it found.
    const other = "# Deploy\n\nDeploy from the release branch.";
    await save("trusting", "project", { key: "deploy-2", work: "reply:m2", markdown: other });
    await recover();
    const after = await shares();
    expect(after.find((each) => each.id === first?.id)).toMatchObject({ state: "waiting", version: null });
    expect(await page(theSite)).toMatchObject({ markdown: other });
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-379] knows its own restore after a later edit, and finishes the Undo", async () => {
    await Effect.runPromise(yourEdit("# Deploy\n\nAsk Bram."));
    await save("trusting", "project");
    const [shared] = await shares();
    cut.set("restore", "after");
    expect((await request("POST", `/api/memory/shares/${shared?.id}/undo`)).status).toBe(503);
    await Effect.runPromise(yourEdit("# Deploy\n\nAsk Bram, or Kit."));
    await recover();
    expect((await shares())[0]).toMatchObject({ state: "undone", pending: null });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nAsk Bram, or Kit." });
    expect(await page(adasOwn)).toMatchObject({ markdown: MARKDOWN });
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-380] records an Undo's restore before the hob's own copy, so a later edit cannot strand it", async () => {
    await Effect.runPromise(yourEdit("# Deploy\n\nAsk Bram."));
    await save("trusting", "project");
    const [shared] = await shares();
    // The restore lands; writing Ada's own copy does not.
    cut.set("write", "before");
    expect((await request("POST", `/api/memory/shares/${shared?.id}/undo`)).status).toBe(503);
    expect((await shares())[0]).toMatchObject({ state: "sending", pending: "restored" });
    await Effect.runPromise(yourEdit("# Deploy\n\nAsk Bram, or Kit."));
    await recover();
    expect((await shares())[0]).toMatchObject({ state: "undone", pending: null });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nAsk Bram, or Kit." });
    expect(await page(adasOwn)).toMatchObject({ markdown: MARKDOWN });
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-385] never takes the same lines in another order for its own write, and waits for you again", async () => {
    await save("balanced", "project");
    const [first] = await shares();
    cut.set("write", "before");
    expect((await request("POST", `/api/memory/shares/${first?.id}/share`, {})).status).toBe(503);
    // Ada's other share holds every line of this one, in another order; your edit lands on top.
    const reordered = "Run `pnpm deploy` from the repository root.\n\n# Deploy";
    await save("trusting", "project", { key: "deploy-2", work: "reply:m2", markdown: reordered });
    await Effect.runPromise(yourEdit(`${reordered}\n\nThen tell Bram.`));
    await recover();
    expect((await shares()).find((each) => each.id === first?.id)).toMatchObject({ state: "waiting", version: null });
    expect(await page(theSite)).toMatchObject({ markdown: `${reordered}\n\nThen tell Bram.` });
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-386] leaves a share under way while memory cannot answer what a version holds whole, then finishes it", async () => {
    await save("balanced", "project");
    const [waiting] = await shares();
    cut.set("write", "after");
    expect((await request("POST", `/api/memory/shares/${waiting?.id}/share`, {})).status).toBe(503);
    const written = await page(theSite);
    await Effect.runPromise(yourEdit("# Deploy\n\nRun `pnpm deploy`, then tell Bram."));
    // A diff cut short, or none at all, proves nothing either way: the share is neither shared nor sent back.
    textCut = 1;
    await recover();
    expect((await shares())[0]).toMatchObject({ state: "sending", pending: "share" });
    await recover();
    expect((await shares())[0]).toMatchObject({ state: "shared", version: written?.version });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nRun `pnpm deploy`, then tell Bram." });
  });

  // covers ADR 028 (Sharing), STD-DATA-001, #960
  it("[TC-GEN-382] keeps an Undo past its restore when the hob's own page changes meanwhile, and finishes it", async () => {
    await Effect.runPromise(yourEdit("# Deploy\n\nAsk Bram."));
    await save("trusting", "project");
    const [shared] = await shares();
    // The restore lands; just before the hob's own copy is written, a page lands there first.
    cut.set(
      "write",
      store.write(
        { _tag: "Hob", agentId: ada, projects: [] },
        adasOwn,
        { path: PAGE, markdown: "# Deploy\n\nAda's own note.", tags: [], pinned: false },
        { _tag: "New" },
      ),
    );
    expect((await request("POST", `/api/memory/shares/${shared?.id}/undo`)).status).toBe(409);
    // The shared page is back as it was, so the share never goes back to shared: it stays past the restore.
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nAsk Bram." });
    expect((await shares())[0]).toMatchObject({ state: "sending", pending: "restored" });
    await recover();
    expect((await shares())[0]).toMatchObject({ state: "undone", pending: null });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nAsk Bram." });
    expect(await page(adasOwn)).toMatchObject({ markdown: MARKDOWN });
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-381] never restores over a change that lands between Undo's read and its restore", async () => {
    await Effect.runPromise(yourEdit("# Deploy\n\nAsk Bram."));
    await save("trusting", "project");
    const [shared] = await shares();
    cut.set("restore", yourEdit("# Deploy\n\nYours, just now."));
    const refused = await request<{ _tag: string }>("POST", `/api/memory/shares/${shared?.id}/undo`);
    expect(refused).toMatchObject({ status: 409, body: { _tag: "MemoryShareChangedMeanwhile" } });
    expect(await page(theSite)).toMatchObject({ markdown: "# Deploy\n\nYours, just now." });
    expect((await shares())[0]).toMatchObject({ state: "shared", pending: null });
  });
});

describe("Check now", () => {
  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-370] finds pages that disagree or look out of date in every scope, and keeps the last check", async () => {
    expect((await request("GET", "/api/memory/check")).body).toEqual({ checkedAt: null, findings: [] });
    await Effect.runPromise(
      store.write(you, theSite, { path: PAGE, markdown: MARKDOWN, tags: [], pinned: false }, { _tag: "New" }),
    );
    const finding = { kind: "stale", scope: theSite, paths: [PAGE], message: "Last used in 2025." } as const;
    controls.flag(finding);
    const checked = await request<{ checkedAt: string; findings: unknown }>("POST", "/api/memory/check");
    expect(checked.status).toBe(200);
    expect(checked.body.findings).toEqual([finding]);
    expect((await request("GET", "/api/memory/check")).body).toEqual(checked.body);
    // Nothing waits in the Inbox for it: Check now's findings are not shares.
    expect(await shares()).toEqual([]);
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-GEN-371] answers 503 while memory does not answer, and changes nothing", async () => {
    controls.setDown(true);
    const checked = await request<{ _tag: string }>("POST", "/api/memory/check");
    controls.setDown(false);
    expect(checked).toMatchObject({ status: 503, body: { _tag: "MemoryNotAnswering" } });
    expect((await request("GET", "/api/memory/check")).body).toEqual({ checkedAt: null, findings: [] });
  });
});
