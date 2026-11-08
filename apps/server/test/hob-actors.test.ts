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
  PermissionSummary,
} from "@hobbots/agents";
import { type Agent, AgentId, type ChangeActor, roleFields, TaskId, YOU } from "@hobbots/domain";
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
import { Effect, Layer, ManagedRuntime, Option } from "effect";
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

// Each hob event the hub journaled, oldest first, as the hob's name, status and who made the change.
const journaled = () =>
  runtime.runPromise(
    EventJournal.use((journal) => journal.readAfter(0)).pipe(
      Effect.map((entries) =>
        entries.flatMap(({ payload }) =>
          payload._tag === "AgentUpserted" ? [[payload.agent.name, payload.agent.status, payload.actor] as const] : [],
        ),
      ),
    ),
  );

const versionActors = (id: AgentId, versions: ReadonlyArray<number>) =>
  runtime.runPromise(
    HobbotsRepository.use((repo) =>
      Effect.forEach(versions, (version) =>
        repo.findAgentConfig(id, version).pipe(Effect.map((config) => Option.getOrThrow(config).actor)),
      ),
    ),
  );

describe("who changed a hob", () => {
  // covers AG-002
  it("[TC-AG-405-03] makes a rename from the profile a new version made by you, refused as a name on create is", async () => {
    const created = (await request("POST", "/api/agents", hob)).body as Agent;
    expect(created).toMatchObject({ summonedBy: null, summonedFor: null, summonedUnattended: false });

    const renamed = await request("PATCH", `/api/agents/${created.id}`, { name: "Bramble" });
    expect(renamed.body).toMatchObject({ name: "Bramble", configVersion: 2 });
    for (const name of ["  ", " Bramble", "x".repeat(41)]) {
      expect(await request("POST", "/api/agents", { ...hob, name })).toMatchObject({
        status: 400,
        body: { _tag: "InvalidHob", field: "name" },
      });
      expect(await request("PATCH", `/api/agents/${created.id}`, { name })).toMatchObject({
        status: 400,
        body: { _tag: "InvalidHob", field: "name" },
      });
    }
    await request("POST", `/api/agents/${created.id}/pause`);

    expect(await versionActors(created.id, [1, 2])).toEqual([YOU, YOU]);
    expect(await journaled()).toEqual([
      ["Wren", "active", YOU],
      ["Bramble", "active", YOU],
      ["Bramble", "paused", YOU],
    ]);
  });

  // covers AG-002, AG-006
  it("[TC-AG-405-04] records the hob that summoned a hob, and the hob or proposal behind each change, version and event", async () => {
    const chief = AgentId.make("chief");
    const call = { scope: "task:hire", key: "hire-engineers" };
    const byChief: ChangeActor = { _tag: "Hob", hobId: chief, call };
    const proposed: ChangeActor = { _tag: "YouApplyingProposal", hobId: chief, proposalId: "proposal-1", call };

    const summoned = await runtime.runPromise(
      HobService.use((hobs) => hobs.create(hob, { actor: byChief, taskId: TaskId.make("hire"), unattended: true })),
    );
    expect(summoned).toMatchObject({ summonedBy: chief, summonedFor: "hire", summonedUnattended: true });
    const confirmed = await runtime.runPromise(
      HobService.use((hobs) => hobs.create({ ...hob, name: "Moss" }, { actor: proposed })),
    );
    expect(confirmed).toMatchObject({ summonedBy: chief, summonedFor: null, summonedUnattended: false });

    await runtime.runPromise(HobService.use((hobs) => hobs.update(summoned.id, { name: "Ash" }, byChief)));
    await runtime.runPromise(
      HobService.use((hobs) => hobs.updatePolicy(summoned.id, { overrides: { "delete-files": "deny" } }, proposed)),
    );
    await runtime.runPromise(HobLifecycle.use((lifecycle) => lifecycle.pause(summoned.id, byChief)));
    await runtime.runPromise(HobLifecycle.use((lifecycle) => lifecycle.wake(summoned.id, byChief)));
    await runtime.runPromise(HobLifecycle.use((lifecycle) => lifecycle.retire(summoned.id, "finish", byChief)));

    expect(await versionActors(summoned.id, [1, 2, 3])).toEqual([byChief, byChief, proposed]);
    expect(await versionActors(confirmed.id, [1])).toEqual([proposed]);
    expect(await journaled()).toEqual([
      ["Wren", "active", byChief],
      ["Moss", "active", proposed],
      ["Ash", "active", byChief],
      ["Ash", "active", proposed],
      ["Ash", "paused", byChief],
      ["Ash", "active", byChief],
      ["Ash", "retired", byChief],
    ]);
    // The API reads who summoned each hob.
    const listed = (await request("GET", "/api/agents")).body as ReadonlyArray<Agent>;
    expect(listed.map((agent) => [agent.name, agent.summonedBy])).toEqual([["Moss", chief]]);
  });
});
