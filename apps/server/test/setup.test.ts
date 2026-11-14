import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
} from "@hobbots/agents";
import { type HobChange, OWNER_ACTOR, roleFields, type SettingChange } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  HobChangesLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Folders are checked on the hub, so the tests make real ones.
// Canonical, since the hub stores folders with symlinks resolved (on macOS the temp folder is one).
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-setup-")));
const code = join(temp, "code");
const notes = join(temp, "notes");
mkdirSync(code);
mkdirSync(notes);
writeFileSync(join(temp, "todo.txt"), "");
afterAll(() => rmSync(temp, { recursive: true, force: true }));

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

// A fresh database per test: the whole API over the test database, without seeded hobs.
beforeEach(() => {
  const Persistence = Layer.mergeAll(
    HobbotsRepositoryLive,
    ApprovalRepositoryLive,
    GrantRepositoryLive,
    TaskRepositoryLive,
    EventJournal.layer,
    BackpackLive,
    SetupRepository.layer,
    HobChangesLive,
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

const request = (method: string, path: string, body?: unknown) =>
  handler(
    new Request(
      `http://localhost:4317${path}`,
      // As the web client sends it: only a user session changes the setup (PE-006).
      {
        method,
        headers: { "content-type": "application/json", host: "localhost:4317", ...AS_WINDOW },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
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
      summoningForEveryHob: null,
    });

    const hobs = await request("GET", "/api/agents");
    expect(await hobs.json()).toEqual([]);
  });

  // covers OP-001, PE-001
  it("[TC-OP-005] stores the preset and folders, completes setup and keeps the result", async () => {
    const chosen = await request("PATCH", "/api/setup", {
      safetyPreset: "trusting",
      approvedFolders: [code, `${notes}/`, join(code, "..", "code")],
    });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toEqual({
      completed: false,
      safetyPreset: "trusting",
      approvedFolders: [code, notes],
      connectedProviders: [],
      summoningForEveryHob: null,
    });

    const finished = {
      completed: true,
      safetyPreset: "trusting",
      approvedFolders: [code, notes],
      connectedProviders: [],
      summoningForEveryHob: null,
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
      summoningForEveryHob: null,
    });
  });

  // covers OP-001, PE-001
  it("[TC-OP-014] refuses a folder that is not a full path to a folder on the hub, and stores none", async () => {
    for (const folder of ["code", join(temp, "missing"), join(temp, "todo.txt")]) {
      const response = await request("PATCH", "/api/setup", { approvedFolders: [code, folder] });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ _tag: "InvalidFolder", folder });
    }
    const stored = (await (await request("GET", "/api/setup")).json()) as { approvedFolders: unknown };
    expect(stored.approvedFolders).toEqual([]);
  });

  // covers #1225: a new shared folder is opened once, so macOS asks about Documents then. Root opens
  // any folder, so the refusal shows only for an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    "[TC-RT-1225-03] refuses a new folder the hub can't open, and stores none",
    async () => {
      const closed = join(temp, "closed");
      mkdirSync(closed);
      chmodSync(closed, 0o000);
      try {
        const response = await request("PATCH", "/api/setup", { approvedFolders: [code, closed] });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ _tag: "InvalidFolder", folder: closed });
      } finally {
        chmodSync(closed, 0o755);
      }
      const stored = (await (await request("GET", "/api/setup")).json()) as { approvedFolders: unknown };
      expect(stored.approvedFolders).toEqual([]);
    },
  );

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

  // covers PE-001, AG-002, #1357
  it("[TC-OP-1357-03] keeps who turned Summoning for every hob on, changed its answers and turned it off, in Settings and in the History of the hob it reached", async () => {
    const hob = (await (
      await request("POST", "/api/agents", {
        name: "Pip",
        ...roleFields("writer"),
        lookSeed: 4821,
        lookColor: "violet",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
      })
    ).json()) as { id: string };
    const scope = { summoned: true, self: false, hobs: [] };
    for (const summoningForEveryHob of [
      { scope, overrides: {} },
      { scope, overrides: { "summoning.summon": "allow" } },
      // The same answers again change nothing, so they leave no record.
      { scope, overrides: { "summoning.summon": "allow" } },
      null,
    ]) {
      expect((await request("PATCH", "/api/setup", { summoningForEveryHob })).status).toBe(200);
    }
    // Completing setup changes no authority setting.
    await request("PATCH", "/api/setup", { completed: true });

    const log = (await (await request("GET", "/api/setup/changes")).json()) as {
      changes: ReadonlyArray<SettingChange>;
      more: boolean;
    };
    expect(log.more).toBe(false);
    expect(log.changes.map((change) => change.actor)).toEqual([OWNER_ACTOR, OWNER_ACTOR, OWNER_ACTOR]);
    const [off, answered, on] = log.changes.map((change) => change.diff);
    expect(on).toMatchObject({ setting: "summoningForEveryHob", before: null, after: { scope } });
    expect(answered).toMatchObject({ after: { overrides: { "summoning.summon": "allow" } } });
    expect(off).toMatchObject({ before: { overrides: { "summoning.summon": "allow" } }, after: null });

    const history = (await (await request("GET", `/api/agents/${hob.id}/changes`)).json()) as ReadonlyArray<HobChange>;
    expect(history.filter((change) => change._tag === "Setting").map((change) => change.setting)).toEqual(log.changes);
  });
});
