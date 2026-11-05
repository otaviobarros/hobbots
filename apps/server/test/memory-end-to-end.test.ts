import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import {
  ActivityRecorder,
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  MemoryStore,
  PermissionSummary,
  SecretRedaction,
  TaskFiles,
} from "@hobbots/agents";
import {
  type Agent,
  isInProgress,
  MEMORY_SAVE_LABEL,
  MEMORY_SEARCH_LABEL,
  MemoryPath,
  type Message,
  roleFields,
  type Thread,
} from "@hobbots/domain";
import { Dispatcher } from "@hobbots/inbox";
import { MemoryProjectsLive, MemoryToolsLive } from "@hobbots/memory";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ActivityRepositoryLive,
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  MemorySavesLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { ActivityStoreLive, FolderScannerLive, HobFilesLive } from "@hobbots/workbench";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { ToolLogsLive } from "../src/tool-logs.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #955 at hub level: hobs reach memory only through the hub's memory tools (ADR 028), with the hub's
// own composition (the memory tools beside the Task tools), the fake runtime making the scripted
// calls, the in-memory store, and the save records on SQLite or PostgreSQL (TestDatabase). Claude
// Code and Codex serve the same hub tools with no change of their own (TC-GEN-252).

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-memory-e2e-")));
const project = join(temp, "app");
const dataDir = join(temp, "data");
for (const folder of [project, dataDir]) mkdirSync(folder, { recursive: true });
execFileSync("git", ["init", "--quiet", project]);
execFileSync("git", ["-C", project, "remote", "add", "origin", "git@github.com:me/app.git"]);

const memory = makeMemoryStoreFake();
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const Memory = MemoryToolsLive.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(MemoryStore, memory.store), MemoryProjectsLive, PolicyEngine.node)),
  );
  const App = Layer.mergeAll(HobLifecycle.layer, WakeOnArrival)
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    .pipe(Layer.provideMerge(ContinuationsLive))
    .pipe(
      Layer.provideMerge(
        StepRunnerLive().pipe(
          Layer.provideMerge(MemberContinuationsLive),
          Layer.provideMerge(TaskTools.layer("/")),
          Layer.provideMerge(TaskSignal.layer),
        ),
      ),
    )
    .pipe(Layer.provideMerge(Dispatcher.layer().pipe(Layer.provideMerge(DispatcherHostLive))))
    .pipe(
      Layer.provideMerge(
        Layer.merge(ActivityRecorder.layer(), TaskFiles.layer.pipe(Layer.provide(HobFilesLive))).pipe(
          Layer.provideMerge(Layer.merge(FolderScannerLive, ActivityStoreLive(join(dataDir, "activity")))),
        ),
      ),
    )
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(Memory))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
            TaskToolCallsLive,
            MemorySavesLive,
            ActivityRepositoryLive,
            EventJournal.layer,
            BackpackLive,
            SetupRepository.layer,
            SearchIndex.layer,
          ).pipe(Layer.provideMerge(TestDatabase)),
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
          FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
          SecretRedaction.layer([]),
          ToolLogsLive(join(dataDir, "tool-logs")),
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

afterAll(async () => {
  await dispose();
  rmSync(temp, { recursive: true, force: true });
});

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://localhost:4578${path}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
    ),
  );

const messages = async (thread: Thread) =>
  (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body;

/** Sends `lines` as one message and waits until its reply has ended. */
const exchange = async (thread: Thread, ...lines: Array<string>) => {
  const before = (await messages(thread)).length;
  const sent = await request("POST", `/api/threads/${thread.id}/messages`, { content: lines.join("\n") });
  expect(sent.status).toBe(200);
  return eventually(async () => {
    const all = await messages(thread);
    const last = all.at(-1);
    return all.length >= before + 2 && last?.role === "assistant" && !isInProgress(last.status) ? last : undefined;
  });
};

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

const summon = async (name: string, lookSeed: number) =>
  (
    await request<Agent>("POST", "/api/agents", {
      name,
      ...roleFields("writer"),
      lookSeed,
      lookColor: "moss",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    })
  ).body;

const lesson = {
  key: "tests",
  scope: "mine",
  path: "notes/tests.md",
  markdown: "# Tests\n\nThis repository runs its tests with `pnpm test`.",
};

describe("hobs remember through the hub, end to end", () => {
  // covers ADR 028 (The memory tools)
  it("[TC-GEN-254] a lesson a hob saves in one thread is found in its next thread, never by another hob, and Never refuses before memory", async () => {
    await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [project] });
    const pip = await summon("Pip", 955);
    const quill = await summon("Quill", 956);

    const first = (await request<Thread>("POST", `/api/agents/${pip.id}/threads`)).body;
    // The same call twice in one turn, as a runtime retries it: the second answers the first answer.
    const saved = await exchange(
      first,
      "Remember how the tests run",
      hub("memory_save", lesson),
      hub("memory_save", lesson),
    );
    expect(saved.content.match(/memory_save: Saved notes\/tests.md to your memory./g)).toHaveLength(2);
    expect(saved.steps.find((step) => step.label === MEMORY_SAVE_LABEL)).toMatchObject({ state: "done" });
    const page = await Effect.runPromise(
      memory.store.page({ _tag: "You" }, { _tag: "Hob", agentId: pip.id }, MemoryPath.make("notes/tests.md")),
    );
    expect(page).toMatchObject({ author: { _tag: "Hob", agentId: pip.id } });

    const history = await Effect.runPromise(
      memory.store.history({ _tag: "You" }, { _tag: "Hob", agentId: pip.id }, MemoryPath.make("notes/tests.md")),
    );
    expect(history).toHaveLength(1);

    const next = (await request<Thread>("POST", `/api/agents/${pip.id}/threads`)).body;
    const found = await exchange(next, "How do the tests run?", hub("memory_search", { query: "pnpm test" }));
    expect(found.content).toContain("Tests (notes/tests.md, in your memory)");
    expect(found.steps.find((step) => step.label === MEMORY_SEARCH_LABEL)).toBeDefined();

    const theirs = (await request<Thread>("POST", `/api/agents/${quill.id}/threads`)).body;
    const nothing = await exchange(theirs, "How do the tests run?", hub("memory_search", { query: "pnpm test" }));
    expect(nothing.content).toContain('memory_search: Memory holds nothing that matches "pnpm test".');

    // Never for Save to memory: the tool is not offered, and a call is refused before memory sees it.
    const narrowed = await request("PATCH", `/api/agents/${pip.id}/permissions`, {
      overrides: { "save-memory": "deny" },
    });
    expect(narrowed.status).toBe(200);
    const refused = await exchange(
      next,
      "Remember this too",
      hub("memory_save", { ...lesson, key: "other", path: "notes/other.md" }),
    );
    expect(refused.content).not.toContain("Saved notes/other.md");
    const other = await Effect.runPromise(
      memory.store.page({ _tag: "You" }, { _tag: "Hob", agentId: pip.id }, MemoryPath.make("notes/other.md")),
    );
    expect(other).toBeNull();
  });
});
