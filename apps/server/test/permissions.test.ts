import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  RuntimeAdapter,
} from "@hobbots/agents";
import { type Agent, type Message, PRESET_DECISIONS, roleFields } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { fakeEnforcement, makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, Schedule, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";

// Folders are checked on the hub, so the tests make real ones. Canonical, since the hub stores
// folders with symlinks resolved (on macOS the temp folder is one).
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-permissions-")));
const shared = join(temp, "shared");
const notes = join(temp, "notes");
const own = join(temp, "own");
mkdirSync(shared);
mkdirSync(notes);
mkdirSync(own);
symlinkSync(own, join(temp, "own-link"));
const sharedLink = join(temp, "shared-link");
symlinkSync(shared, sharedLink);
// A folder that is away at first, like one on an unmounted drive.
const away = join(temp, "away");
const awayLink = join(temp, "away-link");
symlinkSync(away, awayLink);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const hob = {
  name: "Wren",
  ...roleFields("writer"),
  lookSeed: 7,
  lookColor: "moss",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
};

// Each turn waits for this before the runtime replies, so a test can act while a reply is running.
let replyGate: Promise<void>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

// Starts the hub; `legacyFolders` are shared folders stored as an earlier version saved them, as typed.
const start = (legacyFolders?: ReadonlyArray<string>, sandbox: "on" | "unavailable" = "on") => {
  replyGate = Promise.resolve();
  const fake = makeFakeRuntime({ sandbox });
  const runtime = Layer.succeed(RuntimeAdapter, {
    ...fake,
    sendPrompt: (request) => {
      const gate = replyGate;
      return Stream.fromEffect(Effect.promise(() => gate)).pipe(Stream.drain, Stream.concat(fake.sendPrompt(request)));
    },
  });
  const legacy = Layer.effectDiscard(
    Effect.gen(function* () {
      if (legacyFolders === undefined) return;
      const setup = yield* SetupRepository;
      yield* setup.update({ safetyPreset: "balanced", approvedFolders: legacyFolders });
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
        ),
      ),
    )
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          legacy.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                HobbotsRepositoryLive,
                ApprovalRepositoryLive,
                GrantRepositoryLive,
                SetupRepository.layer,
                SearchIndex.layer,
              ).pipe(Layer.provideMerge(TestDatabase)),
            ),
          ),
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
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
};
beforeEach(() => start());
afterEach(() => dispose());

const request = async (method: string, path: string, body?: unknown) => {
  const response = await handler(
    new Request(`http://localhost:4364${path}`, {
      method,
      // As the web client sends it: only a user session changes what a hob may do (PE-006).
      headers: { "content-type": "application/json", host: "localhost:4364", origin: "http://localhost:4364" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const waitFor = (ready: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.tryPromise(ready).pipe(
      Effect.flatMap((done) => (done ? Effect.void : Effect.fail("waiting"))),
      Effect.retry(Schedule.spaced("5 millis")),
    ),
  );

// A Balanced installation with two shared folders and one hob.
const newHob = async (): Promise<Agent> => {
  await request("PATCH", "/api/setup", { safetyPreset: "balanced", approvedFolders: [shared, notes] });
  return (await request("POST", "/api/agents", hob)).body;
};
const permissions = (agent: Agent) => `/api/agents/${agent.id}/permissions`;

describe("a hob's folders", () => {
  // covers AG-002, AG-004
  it("[TC-AG-090] starts with the shared folders and the preset, and stores a folder change as a new version", async () => {
    const agent = await newHob();
    expect(await request("GET", permissions(agent))).toEqual({
      status: 200,
      body: {
        agentId: agent.id,
        configVersion: 1,
        preset: "balanced",
        sharedFolders: [shared, notes],
        policy: { ownFolders: [], hiddenSharedFolders: [], overrides: {} },
        folders: [shared, notes],
        decisions: PRESET_DECISIONS.balanced,
        enforcement: fakeEnforcement("on"),
      },
    });

    // Its own folder is stored canonical, through the symlink, and kept once.
    const changed = await request("PATCH", permissions(agent), {
      ownFolders: [join(temp, "own-link"), own],
      hiddenSharedFolders: [notes],
    });
    expect(changed).toMatchObject({
      status: 200,
      body: {
        configVersion: 2,
        policy: { ownFolders: [own], hiddenSharedFolders: [notes], overrides: {} },
        folders: [shared, own],
      },
    });
    const listed: Array<Agent> = (await request("GET", "/api/agents")).body;
    expect(listed).toMatchObject([{ id: agent.id, configVersion: 2, policy: changed.body.policy }]);

    // The same folders again change nothing and add no version.
    const same = await request("PATCH", permissions(agent), { ownFolders: [own] });
    expect(same.body).toEqual(changed.body);

    // Other edits keep the policy.
    const renamed = await request("PATCH", `/api/agents/${agent.id}`, { instructions: "Be brief." });
    expect(renamed.body).toMatchObject({ configVersion: 3, policy: changed.body.policy });
  });

  // covers AG-004, PE-005
  it("[TC-AG-101] turns commit signing with the user's 1Password key on and off as new versions", async () => {
    const agent = await newHob();
    const on = await request("PATCH", permissions(agent), { signCommits: true });
    expect(on).toMatchObject({
      status: 200,
      body: { configVersion: 2, policy: { ownFolders: [], hiddenSharedFolders: [], overrides: {}, signCommits: true } },
    });
    const listed: Array<Agent> = (await request("GET", "/api/agents")).body;
    expect(listed).toMatchObject([{ id: agent.id, policy: { signCommits: true } }]);
    // Other policy changes keep it.
    const hidden = await request("PATCH", permissions(agent), { hiddenSharedFolders: [notes] });
    expect(hidden.body).toMatchObject({ configVersion: 3, policy: { signCommits: true } });
    // The same answer again adds no version; turning it off does, and leaves it out.
    expect((await request("PATCH", permissions(agent), { signCommits: true })).body.configVersion).toBe(3);
    const off = await request("PATCH", permissions(agent), { signCommits: false });
    expect(off.body.configVersion).toBe(4);
    expect(off.body.policy).toEqual({ ownFolders: [], hiddenSharedFolders: [notes], overrides: {} });
  });

  // covers AG-004
  it("[TC-AG-091] refuses a missing folder, an own folder that is already shared and hiding a folder that is not shared", async () => {
    const agent = await newHob();
    const missing = await request("PATCH", permissions(agent), { ownFolders: [join(temp, "missing")] });
    expect(missing).toMatchObject({ status: 400, body: { _tag: "InvalidFolder" } });
    const alreadyShared = await request("PATCH", permissions(agent), { ownFolders: [shared] });
    expect(alreadyShared).toMatchObject({ status: 400, body: { _tag: "InvalidFolder", folder: shared } });
    const notShared = await request("PATCH", permissions(agent), { hiddenSharedFolders: [own] });
    expect(notShared).toMatchObject({ status: 400, body: { _tag: "InvalidFolder", folder: own } });

    const unknown = await request("PATCH", `/api/agents/${crypto.randomUUID()}/permissions`, { ownFolders: [] });
    expect(unknown).toMatchObject({ status: 404, body: { _tag: "AgentNotFound" } });
    expect((await request("GET", permissions(agent))).body).toMatchObject({
      configVersion: 1,
      folders: [shared, notes],
    });
  });

  // covers AG-002
  it("[TC-AG-092] finishes a running reply with the configuration it started with when the folders change", async () => {
    const agent = await newHob();
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const messages = async () => (await request("GET", `/api/threads/${thread.id}/messages`)).body as Array<Message>;

    let release = () => {};
    replyGate = new Promise((resolve) => {
      release = resolve;
    });
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "first" });
    await waitFor(async () => (await messages()).some((m) => m.status === "streaming"));

    const changed = await request("PATCH", permissions(agent), { ownFolders: [own] });
    expect(changed.body).toMatchObject({ configVersion: 2 });
    release();
    await waitFor(async () => (await messages()).every((m) => m.status !== "streaming"));
    expect((await messages()).map((m) => m.configVersion)).toEqual([null, 1]);
  });
});

describe("a hob's hidden folders", () => {
  // covers AG-004, PE-001
  it("[TC-AG-095] keeps a shared folder saved by an earlier version as a symlink hidden after setup is saved again", async () => {
    await dispose();
    start([sharedLink, notes]);
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;

    // The hub stores the shared folders canonical when it starts.
    expect((await request("GET", permissions(agent))).body).toMatchObject({
      sharedFolders: [shared, notes],
      folders: [shared, notes],
    });

    // Hiding the folder by the spelling the user saved it with hides the folder itself.
    const hidden = await request("PATCH", permissions(agent), { hiddenSharedFolders: [sharedLink] });
    expect(hidden).toMatchObject({
      status: 200,
      body: { configVersion: 2, policy: { hiddenSharedFolders: [shared] }, folders: [notes] },
    });

    // Saving the unchanged setup again does not show it.
    await request("PATCH", "/api/setup", { approvedFolders: [sharedLink, notes] });
    expect((await request("GET", permissions(agent))).body).toMatchObject({
      configVersion: 2,
      sharedFolders: [shared, notes],
      folders: [notes],
    });
  });

  // covers AG-004, PE-001
  it("[TC-AG-096] keeps a shared folder hidden that was away when it was hidden, once it returns and setup is saved again", async () => {
    await dispose();
    start([awayLink, notes]);
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;

    // Away, it keeps the spelling it was saved with, and so does hiding it.
    expect((await request("GET", permissions(agent))).body).toMatchObject({ sharedFolders: [awayLink, notes] });
    const hidden = await request("PATCH", permissions(agent), { hiddenSharedFolders: [awayLink] });
    expect(hidden).toMatchObject({
      status: 200,
      body: { configVersion: 2, policy: { hiddenSharedFolders: [awayLink] }, folders: [notes] },
    });

    // Back, it stays hidden, before and after setup stores it canonical.
    mkdirSync(away);
    expect((await request("GET", permissions(agent))).body).toMatchObject({ folders: [notes] });
    // A second hob can hide it by the folder it names now, though setup still has the old spelling.
    const other: Agent = (await request("POST", "/api/agents", { ...hob, name: "Fern" })).body;
    expect(await request("PATCH", permissions(other), { hiddenSharedFolders: [away] })).toMatchObject({
      status: 200,
      body: { folders: [notes] },
    });
    await request("PATCH", "/api/setup", { approvedFolders: [awayLink, notes] });
    for (const hobAgent of [agent, other]) {
      expect((await request("GET", permissions(hobAgent))).body).toMatchObject({
        sharedFolders: [away, notes],
        folders: [notes],
      });
    }
    expect((await request("GET", permissions(agent))).body).toMatchObject({ configVersion: 2 });
  });
});

describe("a hob's overrides", () => {
  // covers AG-004, PE-001
  it("[TC-AG-093] narrows the preset, and rejects an override that would widen it and stores nothing", async () => {
    const agent = await newHob();

    const widening = await request("PATCH", permissions(agent), {
      overrides: { push: "allow", "delete-files": "allow", "edit-files": "ask" },
    });
    expect(widening).toMatchObject({
      status: 400,
      body: { _tag: "OverrideWidens", preset: "balanced", operations: ["delete-files", "push"] },
    });
    const outside = await request("PATCH", permissions(agent), { overrides: { "outside-folders": "ask" } });
    expect(outside).toMatchObject({ status: 400, body: { _tag: "OverrideWidens", operations: ["outside-folders"] } });
    expect((await request("GET", permissions(agent))).body).toMatchObject({
      configVersion: 1,
      policy: { overrides: {} },
    });

    const narrowed = await request("PATCH", permissions(agent), {
      overrides: { "edit-files": "ask", "use-web": "deny", push: "ask" },
    });
    expect(narrowed).toMatchObject({
      status: 200,
      body: {
        configVersion: 2,
        policy: { overrides: { "edit-files": "ask", "use-web": "deny", push: "ask" } },
        decisions: { ...PRESET_DECISIONS.balanced, "edit-files": "ask", "use-web": "deny" },
      },
    });
  });

  // covers AG-004, PE-008
  it("[TC-AG-094] keeps an override narrowing under a stricter preset picked later", async () => {
    const agent = await newHob();
    await request("PATCH", permissions(agent), { overrides: { "run-commands": "ask", "use-web": "allow" } });
    await request("PATCH", "/api/setup", { safetyPreset: "careful" });

    const careful = await request("GET", permissions(agent));
    // Careful asks before the web, so the stored Allow cannot widen it.
    expect(careful.body).toMatchObject({
      preset: "careful",
      decisions: { ...PRESET_DECISIONS.careful, "use-web": "ask", "run-commands": "ask" },
    });

    // A change that leaves the overrides alone is still accepted.
    const folders = await request("PATCH", permissions(agent), { ownFolders: [own] });
    expect(folders).toMatchObject({ status: 200, body: { configVersion: 3 } });
    // Saving them again is checked against the preset as it is now.
    const again = await request("PATCH", permissions(agent), { overrides: { "use-web": "allow" } });
    expect(again).toMatchObject({ status: 400, body: { _tag: "OverrideWidens", preset: "careful" } });
  });
});

describe("unsupported enforcement", () => {
  // covers PE-005
  it("[TC-PE-042] reports a sandbox that cannot start in the hob's permissions and in provider health", async () => {
    await dispose();
    start(undefined, "unavailable");
    const agent = await newHob();
    const { body } = await request("GET", permissions(agent));
    expect(body.enforcement.processSandbox).toEqual({
      status: "unsupported",
      evidence: "The fake pretends the sandbox cannot start on this hub.",
    });
    // The answers stay the preset's; the hub blocks what needs the sandbox whatever they say.
    expect(body.decisions["run-commands"]).toBe("allow");
    const [health] = (await request("GET", "/api/runtimes")).body;
    expect(health.enforcement).toEqual(body.enforcement);
  });
});
