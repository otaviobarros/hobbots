import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { MemoryOverview } from "@hobbots/api";
import {
  DEFAULT_MEMORY_SETTINGS,
  type MemoryEngineHealth,
  type MemorySettings,
  type RuntimeKind,
} from "@hobbots/domain";
import { type EngineSettings, MemoryEngine, MemoryModelEndpoint } from "@hobbots/memory";
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
import { FakeAdditionalRuntimesLayer, FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { folderBytes, MemorySettingsStore, memorySettingsFile, readMemorySettings } from "../src/memory-settings.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Settings › Your data › Memory (ADR 028, issue #962): the memory model is stored in the data
// folder and handed to the memory engine, which restarts only its own process.

const RUNNING: MemoryEngineHealth = {
  state: "running",
  offReason: null,
  version: "3.4.2",
  restarts: 0,
  lastExit: null,
  runningSince: "2026-11-05T00:00:00.000Z",
};

let dataDir: string;
let reconfigured: Array<EngineSettings>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

/** An engine that records each reconfigure, and answers a page count and its model's use. */
const RecordingEngine = Layer.sync(MemoryEngine, () =>
  MemoryEngine.of({
    health: Effect.succeed(RUNNING),
    endpoint: Effect.succeed(Option.none()),
    reconfigure: (settings) => Effect.sync(() => void reconfigured.push(settings)),
    backup: () => Effect.succeed(false),
    status: Effect.succeed({ pages: 12, usage: { calls: 3, inputTokens: 900, outputTokens: 100, since: null } }),
  }),
);

/** The plans' limits as the memory model endpoint last met them. */
const limited = new Map<RuntimeKind, string | null>();
const LimitsEndpoint = Layer.succeed(MemoryModelEndpoint, {
  url: "http://127.0.0.1:9",
  limited: (runtime) =>
    Effect.succeed(limited.has(runtime) ? Option.some({ resetsAt: limited.get(runtime) ?? null }) : Option.none()),
});

beforeEach(async () => {
  limited.clear();
  dataDir = mkdtempSync(join(tmpdir(), "hobbots-memory-settings-"));
  reconfigured = [];
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
        FakeAdditionalRuntimesLayer({ availability: "signedOut" }),
        RecordingEngine,
        LimitsEndpoint,
        MemorySettingsStore.layer(dataDir),
        Layer.succeed(Installation, { app: "hobbots", installationId: "memory-test", version: "0.0.0", dataDir }),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provide(Layer.succeedContext(await runtime.context())),
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

afterEach(async () => {
  await dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

const decode = Schema.decodeUnknownSync(MemoryOverview);
const request = async (method: "GET" | "PUT", path: string, body?: unknown) => {
  const response = await handler(
    new Request(`http://localhost:4390${path}`, {
      method,
      headers: { ...AS_WINDOW, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as unknown };
};

describe("the memory model in Settings", () => {
  // covers ADR 028
  it("[TC-GEN-219] starts from the runtime's smallest model at low effort, and shows the engine, its pages and its use", async () => {
    mkdirSync(join(dataDir, "memory", "wiki"), { recursive: true });
    writeFileSync(join(dataDir, "memory", "wiki", "notes.md"), "# Notes\n");
    const { status, body } = await request("GET", "/api/memory");
    expect(status).toBe(200);
    const overview = decode(body);
    expect(overview.settings).toEqual(DEFAULT_MEMORY_SETTINGS);
    expect(overview.settings).toMatchObject({ model: null, effort: "low" });
    // Claude Code is ready: memory runs on its smallest main model, as the runtime reports it.
    expect(overview.state).toEqual({ _tag: "Model", model: "fake-thinker", replaced: null });
    expect(overview.engine).toEqual(RUNNING);
    expect(overview.pages).toBe(12);
    expect(overview.bytes).toBe("# Notes\n".length);
    expect(overview.usage?.calls).toBe(3);
    // Nothing about the engine's address or keys.
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|bearer|"url"|"root"|"proxy"/i);
  });

  // covers ADR 028
  it("[TC-GEN-220] stores a changed model in the data folder and restarts only the memory engine", async () => {
    const chosen: MemorySettings = {
      ...DEFAULT_MEMORY_SETTINGS,
      provider: "chatgpt",
      model: "fake-coder",
      effort: "medium",
      fallback: "other",
      tasks: { summaries: "none", check: "fake-coder", answers: "same" },
    };
    const { status, body } = await request("PUT", "/api/memory/settings", chosen);
    expect(status).toBe(200);
    expect(decode(body).settings).toEqual(chosen);
    expect(readMemorySettings(dataDir)).toEqual(chosen);
    expect(JSON.parse(readFileSync(memorySettingsFile(dataDir), "utf8"))).toEqual(chosen);
    // The engine gets the chosen runtime's model, the other's smallest as its fallback, and the task's own.
    expect(reconfigured).toEqual([
      {
        model: { runtime: "codex", name: "fake-coder" },
        effort: "medium",
        fallbacks: [{ runtime: "claude-code", name: "smallest" }],
        tasks: { lint: { runtime: "codex", name: "fake-coder" } },
        summarize: false,
      },
    ]);

    const off = await request("PUT", "/api/memory/settings", { ...chosen, provider: "none" });
    expect(decode(off.body).state).toEqual({ _tag: "NoAi" });
    expect(reconfigured.at(-1)).toEqual({ model: null });
  });

  // covers ADR 028
  it("[TC-GEN-221] refuses a model id that is not a plain name, and reads a damaged file as the default", async () => {
    const refused = await request("PUT", "/api/memory/settings", { ...DEFAULT_MEMORY_SETTINGS, model: 'x"\n[auth]' });
    expect(refused.status).toBe(400);
    expect(reconfigured).toEqual([]);
    writeFileSync(memorySettingsFile(dataDir), "{ not json");
    expect(readMemorySettings(dataDir)).toEqual(DEFAULT_MEMORY_SETTINGS);
    writeFileSync(memorySettingsFile(dataDir), JSON.stringify({ ...DEFAULT_MEMORY_SETTINGS, effort: "extreme" }));
    expect(readMemorySettings(dataDir)).toEqual(DEFAULT_MEMORY_SETTINGS);
  });

  // covers ADR 028
  it("[TC-GEN-320] says when the chosen runtime is signed out or limited, and runs the smallest model in place of one it stopped offering", async () => {
    // A model the runtime no longer lists falls back to its smallest, and says which.
    await request("PUT", "/api/memory/settings", { ...DEFAULT_MEMORY_SETTINGS, model: "gone-1" });
    expect(decode((await request("GET", "/api/memory")).body).state).toEqual({
      _tag: "Model",
      model: "fake-thinker",
      replaced: "gone-1",
    });

    // The fake Codex answers as signed out: its own state, as provider health reports it.
    await request("PUT", "/api/memory/settings", { ...DEFAULT_MEMORY_SETTINGS, provider: "chatgpt" });
    expect(decode((await request("GET", "/api/memory")).body).state).toEqual({
      _tag: "Unavailable",
      provider: "chatgpt",
      state: "signedOut",
      resetsAt: null,
    });

    // Claude Code's plan refused the last memory task for its limit.
    await request("PUT", "/api/memory/settings", DEFAULT_MEMORY_SETTINGS);
    limited.set("claude-code", "2026-11-06T00:00:00.000Z");
    expect(decode((await request("GET", "/api/memory")).body).state).toEqual({
      _tag: "Unavailable",
      provider: "claude",
      state: "limited",
      resetsAt: "2026-11-06T00:00:00.000Z",
    });
  });

  // covers ADR 028
  it("[TC-GEN-223] measures the memory folder without blocking, once for requests that come together", async () => {
    const memory = join(dataDir, "memory");
    mkdirSync(join(memory, "wiki", "projects", "deep"), { recursive: true });
    writeFileSync(join(memory, "wiki", "a.md"), "12345");
    writeFileSync(join(memory, "wiki", "projects", "deep", "b.md"), "123");
    expect(await Effect.runPromise(folderBytes(memory))).toBe(8);
    expect(await Effect.runPromise(folderBytes(join(dataDir, "missing")))).toBeNull();

    // Two overviews in a row measure once: a page added between them shows after the cache expires.
    const first = await Promise.all([request("GET", "/api/memory"), request("GET", "/api/memory")]);
    writeFileSync(join(memory, "wiki", "c.md"), "1234567890");
    const second = await request("GET", "/api/memory");
    expect(first.map(({ body }) => decode(body).bytes)).toEqual([8, 8]);
    expect(decode(second.body).bytes).toBe(8);
    expect(await Effect.runPromise(folderBytes(memory))).toBe(18);
  });
});
