import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ActivityRepository,
  ApprovalService,
  ChatService,
  type CommandDraft,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  HobTools,
  type NewAttempt,
  PermissionSummary,
  SecretRedaction,
  TaskFiles,
  TaskRepository,
} from "@hobbots/agents";
import { AttemptActivityRead, TreeActivityRead } from "@hobbots/api";
import {
  Agent,
  AgentId,
  ArtifactId,
  AttemptFiles,
  AttemptId,
  CommandId,
  type Committed,
  ContentId,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  type EventEnvelope,
  FileChangeId,
  FolderScan,
  FolderScanId,
  OWNER_ACTOR,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import {
  ActivityRepositoryLive,
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
import { HobFilesLive } from "@hobbots/workbench";
import { Effect, Layer, ManagedRuntime, Option, Schedule, Schema } from "effect";
import { makeParser } from "effect/encoding/Sse";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { EventStream, type StreamFrame } from "../src/event-stream.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { encodeTreeFrame, treeFrame, WorkbenchStreamRoute } from "../src/workbench-stream.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Issue #899: one read and one live stream for a Quest's whole Workbench, over the HTTP API and on
// SQLite or PostgreSQL (TestDatabase). Aldric leads a campaign: Quill drafts the copy, fails and is
// retried; Ada builds the campaign as a nested Quest with Pip on the keywords. Another request of
// Aldric's sits beside it in the same thread and never shows in the campaign's Workbench.

/** The campaign's project folder, where Pip leaves the keywords. */
const project = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-workbench-tree-")));
writeFileSync(join(project, "keywords.txt"), "sale\n");
afterAll(() => rmSync(project, { recursive: true, force: true }));

const App = HobLifecycle.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TaskFiles.layer,
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
        ActivityRepositoryLive,
        EventJournal.layer,
        BackpackLive,
        SetupRepository.layer,
        SearchIndex.layer,
      ).pipe(Layer.provideMerge(TestDatabase)),
      EventBus.layer,
      HobAdmission.layer,
      NodeFolderChecks,
      HobFilesLive,
      SecretRedaction.layer([]),
      FakeRuntimeLayer(),
      Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/tmp" }),
    ),
  ),
);
const Hub = Layer.mergeAll(App, EventStream.layer.pipe(Layer.provide(App)));

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof Hub>, Layer.Error<typeof Hub>>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(async () => {
  runtime = ManagedRuntime.make(Hub);
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(ApiRoutes, WorkbenchStreamRoute).pipe(
      Layer.provideMerge(TestDevices),
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

const address = (path: string) => `http://localhost:4390${path}`;

const get = async (path: string, device = true) => {
  const response = await handler(new Request(address(path), { headers: device ? AS_WINDOW : {} }));
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
};

const readTree = async (taskId: string) => {
  const response = await get(`/api/tasks/${taskId}/workbench`);
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(TreeActivityRead)(response.body);
};

const now = "2026-11-04T00:00:00.000Z";
const later = "2026-11-04T00:00:05.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("t1");

let clock = 0;
/** Each Task a second younger than the last, so a tree lists them in the order they were made. */
const task = (id: string, ownerId: AgentId, parentId: string | null) => ({
  id: TaskId.make(id),
  ownerId,
  parentId: parentId === null ? null : TaskId.make(parentId),
  threadId,
  brief: id,
  dependsOn: [],
  createdAt: new Date(Date.parse(now) + 1000 * ++clock).toISOString(),
});

const delegation = (id: string) => ({
  id: DelegationId.make(id),
  brief: `Delegated ${id}`,
  expectedOutput: null,
  authority: { overrides: {}, folders: null },
  timeoutMs: null,
});

const attempt = (id: string): NewAttempt => ({
  id: AttemptId.make(id),
  runtime: "claude-code",
  sessionId: null,
  configVersion: 1,
  policyVersion: null,
  startedAt: now,
});

/** A command the Attempt ran, ended with its whole output kept as a log. */
const command = (attemptId: string, id: string, line: string): CommandDraft => ({
  id: CommandId.make(id),
  attemptId: AttemptId.make(attemptId),
  stepId: `step-${id}`,
  command: line,
  folder: "/work/campaign",
  sandboxed: true,
  liveOutput: true,
  state: "succeeded",
  exitCode: 0,
  startedAt: now,
  endedAt: later,
  output: { head: "done\n", tail: "", omittedBytes: 0, totalBytes: 5, logged: true },
  log: { contentId: ContentId.make("1".repeat(64)), totalBytes: 20_000, omittedBytes: 0 },
  logNotKept: null,
});

const latest = (id: string) =>
  Effect.map(
    TaskRepository.use((tasks) => tasks.readTree(TaskId.make(id))),
    (tree) => {
      const found = Option.getOrThrow(tree).tasks[0];
      if (found === undefined) throw new Error(`no Task ${id}`);
      return found;
    },
  );

/** Starts the Task's next Attempt. */
const start = (taskId: string, attemptId: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    yield* tasks.startAttempt(TaskId.make(taskId), (yield* latest(taskId)).revision, attempt(attemptId));
  });

/** The campaign, its party and their records, and another request of Aldric's beside it. */
const campaign = Effect.gen(function* () {
  yield* (yield* SetupRepository).update({ safetyPreset: "balanced", approvedFolders: [project] }, OWNER_ACTOR);
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [ALDRIC, "Aldric"],
    [QUILL, "Quill"],
    [ADA, "Ada"],
    [PIP, "Pip"],
  ] as const) {
    yield* repo.insertAgent(
      new Agent({
        id,
        name,
        roleTitle: "Guide",
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
  const activity = yield* ActivityRepository;
  yield* tasks.createTask({ task: task("campaign", ALDRIC, null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: TaskId.make("campaign"),
    goal: "A Black Friday campaign",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  yield* tasks.createTask({ task: task("copy", QUILL, "campaign"), delegation: delegation("d-copy"), milestones: [] });
  yield* tasks.createTask({ task: task("build", ADA, "campaign"), delegation: delegation("d-build"), milestones: [] });
  // Ada brings Pip in: a Quest nested one deeper.
  yield* tasks.startQuest({
    id: QuestId.make("q2"),
    taskId: TaskId.make("build"),
    goal: "Build the campaign",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  yield* tasks.createTask({
    task: task("keywords", PIP, "build"),
    delegation: delegation("d-keywords"),
    milestones: [],
  });
  yield* start("campaign", "a-lead");
  yield* activity.saveSteps(
    AttemptId.make("a-lead"),
    [{ id: "read-1", kind: "tool", label: "Reading brief.md", state: "done" }],
    now,
  );
  // Quill's first try fails; the retry is a second Attempt of the same Task.
  yield* start("copy", "a-copy-1");
  yield* activity.saveCommand(command("a-copy-1", "c-copy-1", "npm run draft"));
  yield* tasks.updateAttempt(AttemptId.make("a-copy-1"), {
    _tag: "Ended",
    end: { _tag: "Failed", reason: "It broke." },
    at: now,
  });
  const failed = yield* tasks.moveTask(TaskId.make("copy"), (yield* latest("copy")).revision, "failed", now);
  yield* tasks.retryTask(TaskId.make("copy"), failed.value.revision, later);
  yield* start("copy", "a-copy-2");
  yield* activity.saveCommand(command("a-copy-2", "c-copy-2", "npm run draft -- --again"));
  yield* start("build", "a-build");
  yield* start("keywords", "a-keywords");
  yield* activity.saveChanges(AttemptId.make("a-keywords"), project, [
    {
      id: FileChangeId.make("f-keywords"),
      path: "keywords.txt",
      kind: "added",
      movedFrom: null,
      before: null,
      after: {
        hash: createHash("sha256").update("sale\n").digest("hex"),
        size: 5,
        kind: "text",
        contentId: null,
        notKept: "too-large",
      },
      sharedWith: [],
      settled: true,
      recordedAt: later,
    },
  ]);
  // Another request in the same thread: its own tree.
  yield* tasks.createTask({ task: task("other", ALDRIC, null), delegation: null, milestones: [] });
  yield* start("other", "a-other");
  yield* activity.saveCommand(command("a-other", "c-other", "ls"));
});

/** What a tree's Workbench stream sends: journal entries, running commands' output, and every cursor it moves to. */
const follow = async (path: string) => {
  const response = await handler(new Request(address(path), { headers: AS_WINDOW }));
  expect(response.status).toBe(200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ readonly event: string; readonly data: { readonly [key: string]: unknown } }> = [];
  const parser = makeParser((frame) => {
    if (frame._tag === "Event" && frame.data !== "") frames.push({ event: frame.event, data: JSON.parse(frame.data) });
  });
  const pumping = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  })().catch(() => undefined);
  // Live output is transient: only a connection that is ready hears it.
  await eventually(() => (frames.some((frame) => frame.event === "ready") ? true : undefined));
  return { frames, stop: () => reader.cancel().then(() => pumping) };
};

const eventually = <A>(read: () => A | undefined) =>
  Effect.runPromise(
    Effect.suspend(() => {
      const value = read();
      return value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value);
    }).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 })),
  );

describe("a Quest's whole Workbench", () => {
  // covers UX-002, OR-002, OR-007
  it("[TC-IN-520] reads every Attempt of a party, a retry and a nested Quest in one call, each naming its Task, owner and Attempt", async () => {
    await runtime.runPromise(campaign);

    const read = await readTree("campaign");
    expect(read.activity.taskId).toBe("campaign");
    // By Task, then by number; the other request's Attempt is not in the campaign's tree.
    expect(
      read.activity.attempts.map(({ ownerId, activity }) => [
        activity.attempt.taskId,
        ownerId,
        activity.attempt.id,
        activity.attempt.number,
      ]),
    ).toEqual([
      ["build", ADA, "a-build", 1],
      ["campaign", ALDRIC, "a-lead", 1],
      ["copy", QUILL, "a-copy-1", 1],
      ["copy", QUILL, "a-copy-2", 2],
      ["keywords", PIP, "a-keywords", 1],
    ]);
    const byAttempt = new Map(read.activity.attempts.map((each) => [each.activity.attempt.id, each.activity]));
    expect(byAttempt.get(AttemptId.make("a-copy-1"))?.commands).toMatchObject([
      { id: "c-copy-1", taskId: "copy", attemptId: "a-copy-1", command: "npm run draft" },
    ]);
    expect(byAttempt.get(AttemptId.make("a-copy-2"))?.commands.map((each) => each.id)).toEqual(["c-copy-2"]);
    expect(byAttempt.get(AttemptId.make("a-keywords"))?.changes).toMatchObject([
      { path: "keywords.txt", taskId: "keywords", attemptId: "a-keywords", after: { notKept: "too-large" } },
    ]);
    expect(byAttempt.get(AttemptId.make("a-lead"))?.steps).toMatchObject([{ id: "read-1", label: "Reading brief.md" }]);

    // A Task inside the tree reads its own part: the nested Quest alone.
    const nested = await readTree("build");
    expect(nested.activity.attempts.map(({ activity }) => activity.attempt.id)).toEqual(["a-build", "a-keywords"]);

    // Each Attempt reads as the per-Attempt endpoint reads it.
    // Each Attempt reads as the per-Attempt endpoints read it, its files included.
    for (const { activity, files } of read.activity.attempts) {
      const one = await get(`/api/attempts/${activity.attempt.id}/activity`);
      expect(Schema.decodeUnknownSync(AttemptActivityRead)(one.body).activity).toEqual(activity);
      const listed = await get(`/api/attempts/${activity.attempt.id}/files`);
      expect(Schema.decodeUnknownSync(AttemptFiles)(listed.body).files).toEqual(files);
    }
    expect(read.activity.attempts.find(({ activity }) => activity.attempt.id === "a-keywords")?.files).toMatchObject([
      { path: "keywords.txt", origin: "added", now: "same" },
    ]);
  });

  // covers UX-002, UX-006
  it("[TC-IN-521] says when a tree's details were cleared past the retention window, as each Attempt's read does", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        yield* tasks.updateAttempt(AttemptId.make("a-other"), {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "It broke." },
          at: now,
        });
        yield* tasks.moveTask(TaskId.make("other"), (yield* latest("other")).revision, "failed", now);
        const cleared = yield* ActivityRepository.use((repo) => repo.clearDetails("2026-11-05T00:00:00.000Z", later));
        expect(cleared).toBe(1);
      }),
    );

    const other = await readTree("other");
    expect(other.activity.attempts).toHaveLength(1);
    expect(other.activity.attempts[0]?.activity).toMatchObject({
      detailsClearedAt: later,
      commands: [{ id: "c-other", log: { contentId: null }, logNotKept: "cleared" }],
    });
    // The campaign is still open: its details stay.
    const campaignRead = await readTree("campaign");
    expect(campaignRead.activity.attempts.every(({ activity }) => activity.detailsClearedAt === null)).toBe(true);
  });

  // covers PE-006
  it("[TC-IN-522] refuses a read or a stream without an approved device, and answers 404 for a Task that is not there", async () => {
    await runtime.runPromise(campaign);

    expect((await get("/api/tasks/campaign/workbench", false)).status).toBe(401);
    const refused = await handler(new Request(address("/api/tasks/campaign/workbench/events")));
    expect(refused.status).toBe(401);
    expect((await get("/api/tasks/nothing/workbench")).status).toBe(404);
    expect(
      (await handler(new Request(address("/api/tasks/nothing/workbench/events"), { headers: AS_WINDOW }))).status,
    ).toBe(404);
  });

  // covers UX-002, OR-007
  it("[TC-IN-523] streams the records and the live output of every hob in the tree from the read's cursor, and nothing of another tree", async () => {
    await runtime.runPromise(campaign);
    const read = await readTree("campaign");
    const stream = await follow(`/api/tasks/campaign/workbench/events?after=${read.cursor}`);

    await runtime.runPromise(
      Effect.gen(function* () {
        const activity = yield* ActivityRepository;
        const bus = yield* EventBus;
        const tasks = yield* TaskRepository;
        // The hub announces what a write committed, as its use cases do.
        const announce = <A>(committed: Option.Option<Committed<A>> | Committed<A>) =>
          Option.isOption(committed)
            ? bus.publish(Option.getOrThrow(committed).entries)
            : bus.publish(committed.entries);
        // Another tree's command and output never reach the campaign's stream.
        yield* announce(yield* activity.saveCommand(command("a-other", "c-other-2", "ls -la")));
        yield* bus.publishTransient({
          _tag: "CommandOutput",
          attemptId: AttemptId.make("a-other"),
          taskId: TaskId.make("other"),
          commandId: CommandId.make("c-other-2"),
          offset: 0,
          delta: "other\n",
        });
        // Pip's output in the nested Quest and Quill's retry's command do.
        yield* bus.publishTransient({
          _tag: "CommandOutput",
          attemptId: AttemptId.make("a-keywords"),
          taskId: TaskId.make("keywords"),
          commandId: CommandId.make("c-keywords"),
          offset: 0,
          delta: "ranking\n",
        });
        yield* announce(yield* activity.saveCommand(command("a-copy-2", "c-copy-3", "npm test")));
        // A Task made under the tree after the stream opened joins it, with its Attempt.
        yield* announce(
          yield* tasks.createTask({ task: task("research", PIP, "keywords"), delegation: null, milestones: [] }),
        );
        yield* announce(
          yield* tasks.startAttempt(
            TaskId.make("research"),
            (yield* latest("research")).revision,
            attempt("a-research"),
          ),
        );
        yield* announce(yield* activity.saveCommand(command("a-research", "c-research", "curl example.com")));
        // Pip finishes the research with an artifact: the read's artifacts change.
        yield* announce(
          yield* tasks.completeTask(TaskId.make("research"), (yield* latest("research")).revision, {
            summary: "Researched",
            attemptId: AttemptId.make("a-research"),
            artifacts: [{ id: ArtifactId.make("art-research"), kind: "text", label: "Notes", value: "Sources" }],
            at: later,
            // Pip's turn read the work it was handed, so it was taken up.
            carried: carriedFrom(Option.getOrThrow(yield* tasks.readLedger(TaskId.make("research"))), () => true),
          }),
        );
        // Quill's retry fails too and you give the copy to Ada: the read's owner changes.
        yield* announce(
          yield* tasks.updateAttempt(AttemptId.make("a-copy-2"), {
            _tag: "Ended",
            end: { _tag: "Failed", reason: "It broke again." },
            at: later,
          }),
        );
        yield* announce(yield* tasks.moveTask(TaskId.make("copy"), (yield* latest("copy")).revision, "failed", later));
        yield* announce(yield* tasks.reassignTask(TaskId.make("copy"), (yield* latest("copy")).revision, ADA, later));
      }),
    );

    const reassigned = (frame: (typeof stream.frames)[number]) => {
      const payload = frame.data.payload as { readonly _tag?: string; readonly control?: { readonly _tag: string } };
      return payload?._tag === "TaskStateChanged" && payload.control?._tag === "Reassigned";
    };
    const frames = await eventually(() => (stream.frames.some(reassigned) ? stream.frames : undefined));
    await stream.stop();

    const shown = frames.flatMap(({ event, data }) => {
      if (event === "ready") return ["ready"];
      if (data._tag === "CommandOutput") return [`output ${data.taskId}`];
      const payload = data.payload as { readonly _tag: string; readonly [key: string]: unknown };
      if (payload._tag === "CommandRecorded") return [`command ${(payload.command as { id: string }).id}`];
      const task = payload.task as { readonly id: string; readonly ownerId: string; readonly state: string };
      return [`${payload._tag} ${task.id} ${task.ownerId} ${task.state}`];
    });
    expect(shown).toEqual([
      "ready",
      "output keywords",
      "command c-copy-3",
      "TaskCreated research pip queued",
      "TaskStateChanged research pip active",
      "command c-research",
      "TaskCompleted research pip completed",
      "TaskStateChanged copy quill active",
      "TaskStateChanged copy quill failed",
      "TaskStateChanged copy ada queued",
    ]);

    // What the stream brought is what the tree reads now.
    const after = await readTree("campaign");
    const research = after.activity.attempts.find(({ activity }) => activity.attempt.id === "a-research");
    expect(research?.activity.artifacts.map((artifact) => artifact.id)).toEqual(["art-research"]);
    expect(
      after.activity.attempts.filter(({ activity }) => activity.attempt.taskId === "copy").map((each) => each.ownerId),
    ).toEqual([ADA, ADA]);
  });
});

describe("a tree's Workbench frames", () => {
  const entry = (sequence: number, payload: EventEnvelope["payload"]): StreamFrame => ({
    _tag: "Entry",
    cursor: `e.${sequence}`,
    entry: { sequence, type: payload._tag, version: 1, at: now, payload } as unknown as EventEnvelope,
  });
  const scan = (taskId: string) =>
    new FolderScan({
      id: FolderScanId.make(`s-${taskId}`),
      attemptId: AttemptId.make(`a-${taskId}`),
      taskId: TaskId.make(taskId),
      folder: "/work",
      phase: "end",
      filesScanned: 1,
      stopped: null,
      startedAt: now,
      endedAt: now,
    });

  it("keeps the tree's records, passes over every other entry by its id alone, and drops other trees' output", () => {
    const tree = new Set([TaskId.make("campaign")]);
    const created = entry(2, {
      _tag: "TaskCreated",
      task: { id: TaskId.make("copy"), parentId: TaskId.make("campaign") },
    } as unknown as EventEnvelope["payload"]);
    // A Task made under the tree joins it, and its creation is sent: it is a new lane.
    expect(treeFrame(created, tree)).toBe(created);
    expect(tree.has(TaskId.make("copy"))).toBe(true);
    const elsewhere = entry(3, {
      _tag: "TaskCreated",
      task: { id: TaskId.make("lunch"), parentId: TaskId.make("other") },
    } as unknown as EventEnvelope["payload"]);
    expect(treeFrame(elsewhere, tree)).toEqual({ _tag: "Passed", cursor: "e.3" });
    expect(tree.has(TaskId.make("lunch"))).toBe(false);

    const inside = entry(3, { _tag: "FolderScanned", scan: scan("copy") });
    expect(treeFrame(inside, tree)).toBe(inside);
    const outside = entry(4, { _tag: "FolderScanned", scan: scan("other") });
    const passed = treeFrame(outside, tree);
    expect(passed).toEqual({ _tag: "Passed", cursor: "e.4" });
    // An id with no data moves the client's Last-Event-ID without dispatching an event.
    expect(passed === null ? null : encodeTreeFrame(passed)).toBe("id: e.4\n\n");

    const output = (taskId: string): StreamFrame => ({
      _tag: "Transient",
      event: {
        _tag: "CommandOutput",
        attemptId: AttemptId.make("a"),
        taskId: TaskId.make(taskId),
        commandId: CommandId.make("c"),
        offset: 0,
        delta: "x",
      },
    });
    expect(treeFrame(output("copy"), tree)).toEqual(output("copy"));
    expect(treeFrame(output("other"), tree)).toBeNull();
    expect(treeFrame({ _tag: "KeepAlive" }, tree)).toEqual({ _tag: "KeepAlive" });
  });
});
