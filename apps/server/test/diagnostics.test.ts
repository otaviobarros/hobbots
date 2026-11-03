import { homedir } from "node:os";
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
  PermissionSummary,
  RecoveryLog,
  SecretRedaction,
  TaskRepository,
  WorkHold,
} from "@hobbots/agents";
import { DiagnosticsNow, DiagnosticsReport, QuestTrace } from "@hobbots/api";
import {
  Agent,
  AgentId,
  AttemptId,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  EMPTY_HOB_POLICY,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
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
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Settings › Diagnostics (ADR 026, issue #455): a Quest followed across hobs, Tasks, Attempts and
// runtimes by its IDs, the Now view, and a report that holds no message text, brief or credential.

/** A provider key the hub knows by value, as one in its environment. */
const PROVIDER_KEY = "provider-key-0123456789abcdef";
/** A GitHub token, recognized by its shape alone. */
const GITHUB_TOKEN = `ghp_${"A".repeat(36)}`;
const SHOP = join(homedir(), "hobbots-diagnostics-shop");

/** Whether a restore holds work, as the hub's work hold reports it. */
let held = false;

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
      FakeRuntimeLayer({ availability: "signedOut" }),
      RecoveryLog.layer,
      Layer.succeed(
        WorkHold,
        WorkHold.of({
          held: Effect.sync(() => held),
          release: Effect.sync(() => {
            held = false;
          }),
        }),
      ),
      SecretRedaction.layer([{ value: PROVIDER_KEY, kind: "ANTHROPIC_API_KEY" }]),
      Layer.succeed(Installation, {
        app: "hobbots",
        installationId: "installation-secret-id",
        version: "0.0.0",
        dataDir: "/tmp",
      }),
    ),
  ),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;
let handler: (request: Request) => Promise<Response>;
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
  handler = (request) => web.handler(request);
  dispose = async () => {
    await web.dispose();
    await runtime.dispose();
  };
});

afterEach(async () => {
  held = false;
  await dispose();
});

const get = async (
  path: string,
): Promise<{ readonly status: number; readonly body: unknown; readonly text: string }> => {
  const response = await handler(new Request(`http://localhost:4390${path}`, { headers: AS_WINDOW }));
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
};

const now = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const threadId = ThreadId.make("t1");
const GOAL = "Plan the Black Friday campaign\nKeep it under budget";
const COPY_BRIEF = "Draft the landing copy\nUse the brand voice";
const BUILD_BRIEF = "Build the campaign pages";
const DELEGATED_COPY = "Write three headlines about the secret sale";
const RESULT = "Three headlines, approved";

/**
 * Aldric leads a Quest on the Task you asked for, delegating the copy to Quill and the pages to Ada.
 * Quill's first Attempt failed with an outcome that quotes a token, a known key and a path; Quill's
 * second finished; Ada's still runs, started long ago and silent since.
 */
const twoHobQuest = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [ALDRIC, "Aldric"],
    [QUILL, "Quill"],
    [ADA, "Ada"],
  ] as const) {
    yield* repo.insertAgent(
      new Agent({
        id,
        name,
        roleTitle: "Guide",
        policy: id === ADA ? { ...EMPTY_HOB_POLICY, ownFolders: [SHOP] } : EMPTY_HOB_POLICY,
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        configVersion: 1,
        createdAt: now,
      }),
    );
  }
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "Campaign", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  const task = (id: string, ownerId: AgentId, parentId: string | null, brief: string, second: number) => ({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    threadId,
    brief,
    dependsOn: [],
    createdAt: `2026-11-01T00:00:0${second}.000Z`,
  });
  const delegation = (id: string, brief: string) => ({
    id: DelegationId.make(id),
    brief,
    expectedOutput: null,
    authority: { overrides: {}, folders: null },
    timeoutMs: null,
  });
  yield* tasks.createTask({ task: task("campaign", ALDRIC, null, GOAL, 0), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: TaskId.make("campaign"),
    goal: GOAL,
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  const copy = yield* tasks.createTask({
    task: task("copy", QUILL, "campaign", COPY_BRIEF, 1),
    delegation: delegation("d-copy", DELEGATED_COPY),
    milestones: [],
  });
  const build = yield* tasks.createTask({
    task: task("build", ADA, "campaign", BUILD_BRIEF, 2),
    delegation: delegation("d-build", BUILD_BRIEF),
    milestones: [],
  });
  const attempt = (id: string, sessionId: string) => ({
    id: AttemptId.make(id),
    runtime: "claude-code" as const,
    sessionId,
    configVersion: 1,
    policyVersion: null,
    startedAt: now,
  });
  /** The Task as it is stored now, since each change moves its revision on. */
  const latest = (id: string) =>
    Effect.map(tasks.readTree(TaskId.make(id)), (tree) => {
      const found = Option.getOrThrow(tree).tasks[0];
      if (found === undefined) throw new Error(`no Task ${id}`);
      return found;
    });
  yield* tasks.startAttempt(copy.value.id, copy.value.revision, attempt("a-copy-1", "session-q1"));
  yield* tasks.updateAttempt(AttemptId.make("a-copy-1"), {
    state: "failed",
    outcome: `Push refused for ${GITHUB_TOKEN} with ${PROVIDER_KEY} in ${SHOP}/sale.html and ${homedir()}/notes.txt`,
    at: "2026-11-01T00:01:00.000Z",
  });
  const failed = yield* latest("copy");
  if (failed.state !== "failed") {
    yield* tasks.moveTask(failed.id, failed.revision, "failed", "2026-11-01T00:01:00.000Z");
  }
  const retry = yield* latest("copy");
  yield* tasks.retryTask(retry.id, retry.revision, "2026-11-01T00:02:00.000Z");
  const queued = yield* latest("copy");
  yield* tasks.startAttempt(queued.id, queued.revision, attempt("a-copy-2", "session-q2"));
  const running = yield* latest("copy");
  // Quill's turn carried what its backpack held for the Task, such as the delegation that brought it.
  const carried = carriedFrom(Option.getOrThrow(yield* tasks.readLedger(running.id)), () => true);
  yield* tasks.completeTask(running.id, running.revision, {
    summary: RESULT,
    attemptId: AttemptId.make("a-copy-2"),
    artifacts: [],
    at: "2026-11-01T00:03:00.000Z",
    carried,
  });
  yield* tasks.updateAttempt(AttemptId.make("a-copy-2"), {
    state: "completed",
    at: "2026-11-01T00:03:00.000Z",
  });
  yield* tasks.startAttempt(build.value.id, build.value.revision, attempt("a-build-1", "session-a1"));
  yield* tasks.updateAttempt(AttemptId.make("a-build-1"), { state: "running", at: now });
});

describe("Diagnostics", () => {
  // covers OP-002, OR-002, OR-007
  it("[TC-OP-050] follows a Quest that delegated to two hobs through its Tasks, Delegations, Attempts and runtimes", async () => {
    await runtime.runPromise(twoHobQuest);

    const quests = await get("/api/diagnostics/quests");
    expect(quests.status).toBe(200);
    expect(quests.body).toMatchObject([{ id: "q1", leadId: ALDRIC, state: "active" }]);

    const response = await get("/api/diagnostics/quests/q1");
    expect(response.status).toBe(200);
    const trace = Schema.decodeUnknownSync(QuestTrace)(response.body);
    expect(trace.quest).toMatchObject({ id: "q1", taskId: "campaign", leadId: ALDRIC });
    expect(trace.tree.tasks.map((task) => [task.id, task.ownerId])).toEqual([
      ["campaign", ALDRIC],
      ["copy", QUILL],
      ["build", ADA],
    ]);
    expect(trace.tree.delegations.map((each) => [each.id, each.leadId, each.memberId, each.childTaskId])).toEqual([
      ["d-copy", ALDRIC, QUILL, "copy"],
      ["d-build", ALDRIC, ADA, "build"],
    ]);
    expect(trace.tree.attempts.map((each) => [each.id, each.taskId, each.state, each.runtime, each.sessionId])).toEqual(
      [
        // Oldest first; these all started at the same moment, so by id.
        ["a-build-1", "build", "running", "claude-code", "session-a1"],
        ["a-copy-1", "copy", "failed", "claude-code", "session-q1"],
        ["a-copy-2", "copy", "completed", "claude-code", "session-q2"],
      ],
    );
    // The journal shows each change by type, time and IDs, oldest first, for every Task of the Quest.
    const sequences = trace.journal.map((entry) => entry.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(trace.journal.map((entry) => entry.taskId))).toEqual(new Set(["campaign", "copy", "build"]));
    expect(trace.journal.map((entry) => entry.type)).toContain("QuestStarted");
    expect(trace.journal.map((entry) => entry.type)).toContain("TaskCompleted");
    const sent = (response.body as { readonly journal: ReadonlyArray<object> }).journal;
    expect(sent.every((entry) => !("payload" in entry))).toBe(true);

    expect((await get("/api/diagnostics/quests/nope")).body).toMatchObject({ _tag: "QuestNotFound" });
  });

  // covers OP-002, PE-007
  it("[TC-OP-051] makes a report of the Quest that holds its IDs but no message text, brief, result, path or credential", async () => {
    await runtime.runPromise(twoHobQuest);

    const response = await get("/api/diagnostics/report?questId=q1");
    expect(response.status).toBe(200);
    const report = Schema.decodeUnknownSync(DiagnosticsReport)(response.body);
    expect(report).toMatchObject({
      format: "hobbots.diagnostics",
      version: 1,
      hub: { version: "0.0.0", storage: expect.stringMatching(/^(sqlite|postgres)$/), node: process.versions.node },
    });
    expect(report.runtimes).toContainEqual({
      runtime: "claude-code",
      version: "fake",
      availability: "signedOut",
      signedIn: false,
    });
    expect(report.hub.schemaVersion).toBeGreaterThanOrEqual(37);
    const quest = report.quest;
    expect(quest).toMatchObject({ questId: "q1", taskId: "campaign", leadId: ALDRIC, state: "active" });
    expect(
      quest?.tasks.map((task) => [task.taskId, task.parentTaskId, task.agentId, task.delegation?.memberId]),
    ).toEqual([
      ["campaign", null, ALDRIC, undefined],
      ["copy", "campaign", QUILL, QUILL],
      ["build", "campaign", ADA, ADA],
    ]);
    expect(quest?.tasks[1]?.attempts.map((each) => [each.attemptId, each.runtimeSessionId, each.state])).toEqual([
      ["a-copy-1", "session-q1", "failed"],
      ["a-copy-2", "session-q2", "completed"],
    ]);
    // The failed Attempt's outcome is kept, redacted, with paths named without saying where.
    expect(quest?.tasks[1]?.attempts[0]?.outcome).toBe(
      "Push refused for [redacted: GitHub token] with [redacted: ANTHROPIC_API_KEY] in folder 1/sale.html and ~/notes.txt",
    );
    expect(quest?.journal.length).toBeGreaterThan(0);

    // Titles stay out unless you ask; nothing else that you or a hob wrote is ever in it.
    for (const text of [
      "Plan the Black Friday",
      "Draft the landing copy",
      "Build the campaign pages",
      "brand voice",
      DELEGATED_COPY,
      RESULT,
      GITHUB_TOKEN,
      PROVIDER_KEY,
      homedir(),
      "installation-secret-id",
      "Campaign",
      "Aldric",
    ]) {
      expect(response.text).not.toContain(text);
    }
    expect(quest).not.toHaveProperty("title");

    const titled = Schema.decodeUnknownSync(DiagnosticsReport)(
      (await get("/api/diagnostics/report?questId=q1&titles=true")).body,
    );
    expect(titled.quest?.title).toBe("Plan the Black Friday campaign");
    expect(titled.quest?.tasks.map((task) => task.title)).toEqual([
      "Plan the Black Friday campaign",
      "Draft the landing copy",
      "Build the campaign pages",
    ]);

    expect((await get("/api/diagnostics/report?questId=nope")).body).toMatchObject({ _tag: "QuestNotFound" });
  });

  // covers OP-002, EX-004
  it("[TC-OP-052] shows each runtime's health, stalled work and the last start's recovery errors, redacted", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* twoHobQuest;
        const log = yield* RecoveryLog;
        yield* log.record({
          step: "endAttempt",
          tag: "SqlError",
          message: `database is locked near ${GITHUB_TOKEN}`,
          taskId: TaskId.make("build"),
          attemptId: AttemptId.make("a-build-1"),
          at: now,
        });
      }),
    );

    const response = await get("/api/diagnostics");
    expect(response.status).toBe(200);
    const current = Schema.decodeUnknownSync(DiagnosticsNow)(response.body);
    expect(current.runtimes.map((health) => [health.runtime, health.availability])).toContainEqual([
      "claude-code",
      "signedOut",
    ]);
    // Ada's Attempt has run for a day and recorded nothing: stalled, in the Quest it belongs to.
    expect(current.stalled).toEqual([
      {
        kind: "noProgress",
        agentId: ADA,
        taskId: "build",
        questId: "q1",
        attemptId: "a-build-1",
        itemId: null,
        since: now,
      },
    ]);
    expect(current.recovery).toEqual([
      expect.objectContaining({ tag: "SqlError", message: "database is locked near [redacted: GitHub token]" }),
    ]);
    expect(current.workHeld).toBe(false);

    // A report without a Quest carries the same, in its own fields.
    const report = Schema.decodeUnknownSync(DiagnosticsReport)((await get("/api/diagnostics/report")).body);
    expect(report.quest).toBeNull();
    expect(report.stalled).toEqual(current.stalled);
    expect(report.recovery[0]?.message).toBe("database is locked near [redacted: GitHub token]");
  });

  // covers OP-002, OP-003
  it("[TC-OP-039] says work is held while a restore holds it, in Right now and in the report", async () => {
    held = true;
    const current = Schema.decodeUnknownSync(DiagnosticsNow)((await get("/api/diagnostics")).body);
    const report = Schema.decodeUnknownSync(DiagnosticsReport)((await get("/api/diagnostics/report")).body);
    expect(current.workHeld).toBe(true);
    expect(report.workHeld).toBe(true);
    held = false;
    expect(Schema.decodeUnknownSync(DiagnosticsNow)((await get("/api/diagnostics")).body).workHeld).toBe(false);
  });
});
