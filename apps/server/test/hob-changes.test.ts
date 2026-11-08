import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  CharmCalls,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
} from "@hobbots/agents";
import { type Agent, AgentId, type ChangeActor, CharmCall, type HobChange, roleFields, YOU } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  CharmCallsLive,
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
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

const hob = {
  name: "Wren",
  ...roleFields("writer"),
  lookSeed: 7,
  lookColor: "moss",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
} as const;

const App = HobLifecycle.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
      ApprovalService.layer,
      GrantService.layer,
      HobService.layer,
      PermissionSummary.layer,
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        HobChangesLive,
        CharmCallsLive,
        ApprovalRepositoryLive,
        GrantRepositoryLive,
        TaskRepositoryLive,
        EventJournal.layer,
        BackpackLive,
        SetupRepository.layer,
        SearchIndex.layer,
      ).pipe(Layer.provideMerge(TestDatabase)),
      EventBus.layer,
      HobAdmission.layer,
      NodeFolderChecks,
      FakeRuntimeLayer(),
      Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/tmp" }),
    ),
  ),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;
let request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
let dispose: () => Promise<void>;

beforeEach(async () => {
  runtime = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provide(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  request = async (method, path, body) => {
    const response = await web.handler(
      new Request(`http://localhost:4405${path}`, {
        method,
        headers: { "content-type": "application/json", ...AS_WINDOW },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  dispose = async () => {
    await web.dispose();
    await runtime.dispose();
  };
});

afterEach(() => dispose());

// What a change list says, oldest first: the kind, the version or status, and who made it.
const summary = (changes: ReadonlyArray<HobChange>) =>
  [...changes]
    .reverse()
    .map((change) =>
      change._tag === "Version"
        ? [`v${change.config.version}`, change.previous?.version ?? null, change.actor._tag]
        : [`${change.from}→${change.status}`, null, change.actor._tag],
    );

const chief = AgentId.make("6f1d2c4e-8a5b-4c3d-9e7f-1a2b3c4d5e6f");
const call = { scope: "task:hire", key: "rename-wren" };
const byChief: ChangeActor = { _tag: "Hob", hobId: chief, call };
const now = "2026-11-08T12:00:00.000Z";

describe("a hob's History and the Changes log", () => {
  // covers AG-002, AG-006
  it("[TC-AG-411-01] lists every version and status change with its actor, the one before it and the request behind a hob's change", async () => {
    await request("POST", "/api/agents", { ...hob, id: chief, name: "Chief" });
    const created = (await request("POST", "/api/agents", hob)).body as Agent;
    await runtime.runPromise(
      Effect.gen(function* () {
        const calls = yield* CharmCalls;
        yield* calls.begin(
          new CharmCall({
            agentId: chief,
            ...call,
            attempt: "a1",
            charm: "Summoning",
            tool: "summoning_change",
            input: "{}",
            site: `hob ${created.id}`,
            plan: "{}",
            appliedText: "Changed.",
            state: "applied",
            result: "Changed.",
            threadId: null,
            messageId: null,
            stepId: null,
            createdAt: now,
            updatedAt: now,
          }),
        );
        const hobs = yield* HobService;
        yield* hobs.update(created.id, { name: "Ash" }, byChief);
        yield* HobLifecycle.use((lifecycle) => lifecycle.pause(created.id, byChief));
      }),
    );
    await request("POST", `/api/agents/${created.id}/wake`);

    const history = await request("GET", `/api/agents/${created.id}/changes`);
    expect(history.status).toBe(200);
    const changes = history.body as ReadonlyArray<HobChange>;
    expect(summary(changes)).toEqual([
      ["v1", null, "You"],
      ["v2", 1, "Hob"],
      ["active→paused", null, "Hob"],
      ["paused→active", null, "You"],
    ]);
    const renamed = changes.find((change) => change._tag === "Version" && change.config.version === 2);
    expect(renamed).toMatchObject({
      origin: { charm: "Summoning", taskId: "hire", threadId: null, messageId: null },
      config: { name: "Ash" },
      previous: { name: "Wren" },
    });
    expect(changes.find((change) => change._tag === "Version" && change.config.version === 1)).toMatchObject({
      origin: null,
      previous: null,
    });

    const log = (await request("GET", "/api/hob-changes")).body as { changes: ReadonlyArray<HobChange>; more: boolean };
    expect(log.more).toBe(false);
    expect(summary(log.changes.filter((change) => change.hobId === created.id))).toEqual(summary(changes));
    expect(log.changes.filter((change) => change.hobId === chief)).toHaveLength(1);
    expect(await request("GET", "/api/agents/nobody/changes")).toMatchObject({ status: 404 });
  });

  // covers AG-002
  it("[TC-AG-411-02] reverts the latest change as a new version made by you, and refuses an older one or the first", async () => {
    const created = (await request("POST", "/api/agents", hob)).body as Agent;
    await runtime.runPromise(
      HobService.use((hobs) => hobs.update(created.id, { name: "Ash", instructions: "Planted." }, byChief)),
    );
    expect(await request("POST", `/api/agents/${created.id}/versions/1/revert`)).toMatchObject({
      status: 409,
      body: { _tag: "RevertRefused", reason: "first-version" },
    });

    const reverted = await request("POST", `/api/agents/${created.id}/versions/2/revert`);
    expect(reverted).toMatchObject({ status: 200, body: { name: "Wren", instructions: "", configVersion: 3 } });
    expect(await request("POST", `/api/agents/${created.id}/versions/2/revert`)).toMatchObject({
      status: 409,
      body: { _tag: "RevertRefused", reason: "not-latest" },
    });

    const changes = (await request("GET", `/api/agents/${created.id}/changes`)).body as ReadonlyArray<HobChange>;
    expect(summary(changes)).toEqual([
      ["v1", null, "You"],
      ["v2", 1, "Hob"],
      ["v3", 2, "You"],
    ]);
    // The revert is journaled with you as its actor, so open screens update live.
    const events = await runtime.runPromise(EventJournal.use((journal) => journal.readAfter(0)));
    expect(events.at(-1)?.payload).toMatchObject({ _tag: "AgentUpserted", agent: { configVersion: 3 }, actor: YOU });
  });
  it("[TC-AG-411-05] checks a folder a revert gives back as adding it would: gone is refused, a link is stored canonical", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hob-revert-")));
    try {
      const created = (await request("POST", "/api/agents", hob)).body as Agent;
      const policy = (ownFolders: ReadonlyArray<string>) =>
        runtime.runPromise(HobService.use((hobs) => hobs.updatePolicy(created.id, { ownFolders })));
      const gone = join(root, "gone");
      mkdirSync(gone);
      await policy([gone]);
      await policy([]);
      rmSync(gone, { recursive: true });
      // Reverting the removal would give back a folder no longer on the hub.
      expect(await request("POST", `/api/agents/${created.id}/versions/3/revert`)).toMatchObject({
        body: { _tag: "InvalidFolder", folder: gone },
      });

      const linked = join(root, "linked");
      const target = join(root, "target");
      mkdirSync(linked);
      mkdirSync(target);
      await policy([linked]);
      await policy([]);
      rmSync(linked, { recursive: true });
      symlinkSync(target, linked);
      // The folder is a link now, so the revert stores where it leads, as adding it would.
      const reverted = await request("POST", `/api/agents/${created.id}/versions/5/revert`);
      expect(reverted).toMatchObject({ status: 200, body: { configVersion: 6, policy: { ownFolders: [target] } } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
