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
  TaskRepository,
} from "@hobbots/agents";
import { BackpackRead, MemberWorkRead, QuestRead, TaskTreeRead, ThreadTasksRead } from "@hobbots/api";
import {
  Agent,
  AgentId,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  type EventEnvelope,
  QuestId,
  QuestionId,
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
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { parseCursor } from "../src/event-stream.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";

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
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(async () => {
  runtime = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
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

afterEach(() => dispose());

const get = async (path: string): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await handler(new Request(`http://localhost:4390${path}`));
  return { status: response.status, body: await response.json() };
};

const post = async (path: string, body: unknown, origin?: string) => {
  const response = await handler(
    new Request(`http://localhost:4390${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:4390",
        ...(origin === undefined ? {} : { origin }),
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};

const now = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const threadId = ThreadId.make("t1");

/** Aldric leads a Quest on the Task you asked for, with Quill drafting the copy. */
const quest = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [ALDRIC, "Aldric"],
    [QUILL, "Quill"],
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
  const task = (id: string, ownerId: AgentId, parentId: string | null, createdAt: string) => ({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    threadId,
    brief: id,
    dependsOn: [],
    createdAt,
  });
  yield* tasks.createTask({ task: task("campaign", ALDRIC, null, now), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: TaskId.make("campaign"),
    goal: "A Black Friday campaign",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  return yield* tasks.createTask({
    task: task("copy", QUILL, "campaign", "2026-11-01T00:00:01.000Z"),
    delegation: {
      id: DelegationId.make("d1"),
      brief: "Draft the copy",
      expectedOutput: "Three headlines",
      authority: { overrides: {}, folders: null },
      timeoutMs: null,
    },
    milestones: [],
  });
});

describe("Task and Quest reads", () => {
  // covers OR-002, OR-007
  it("[TC-OR-006] reads a Task tree and a Quest with a cursor the event stream resumes from without missing a change", async () => {
    const copy = await runtime.runPromise(quest);

    const treeResponse = await get("/api/tasks/campaign");
    expect(treeResponse.status).toBe(200);
    const tree = Schema.decodeUnknownSync(TaskTreeRead)(treeResponse.body);
    expect(tree.tree.tasks.map((task) => task.id)).toEqual(["campaign", "copy"]);
    expect(tree.tree.delegations).toMatchObject([{ id: "d1", leadId: ALDRIC, memberId: QUILL }]);

    const questResponse = await get("/api/quests/q1");
    expect(questResponse.status).toBe(200);
    const read = Schema.decodeUnknownSync(QuestRead)(questResponse.body);
    expect(read).toMatchObject({ quest: { id: "q1", taskId: "campaign", leadId: ALDRIC }, party: [QUILL] });
    expect(read.tree).toEqual(tree.tree);
    expect(read.cursor).toBe(tree.cursor);

    // A change after the read is exactly what the stream replays after the read's cursor.
    const moved = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        return yield* tasks.moveTask(copy.value.id, copy.value.revision, "cancelled", now);
      }),
    );
    const replayed: ReadonlyArray<EventEnvelope> = await runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EventJournal;
        return yield* journal.readAfter(parseCursor(tree.cursor)?.sequence ?? -1);
      }),
    );
    expect(replayed.map((entry) => entry.sequence)).toEqual(moved.entries.map((entry) => entry.sequence));
    // The cancel also lands in Aldric's backpack, in the same change (ADR 019).
    expect(replayed.map((entry) => entry.type)).toEqual([
      "TaskStateChanged",
      "CheckpointRecorded",
      "BackpackItemRecorded",
    ]);
  });

  // covers OR-001, OR-007
  it("[TC-OR-010] reads the Tasks a thread's requests started, each with its tree, oldest first", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* quest;
        const tasks = yield* TaskRepository;
        yield* tasks.createTask({
          task: {
            id: TaskId.make("follow-up"),
            ownerId: ALDRIC,
            parentId: null,
            threadId,
            brief: "Plan the follow-up",
            dependsOn: [],
            createdAt: "2026-11-01T00:00:02.000Z",
          },
          delegation: null,
          milestones: [],
        });
      }),
    );

    const response = await get("/api/threads/t1/tasks");
    expect(response.status).toBe(200);
    const read = Schema.decodeUnknownSync(ThreadTasksRead)(response.body);
    expect(read.trees.map((tree) => tree.tasks.map((task) => task.id))).toEqual([["campaign", "copy"], ["follow-up"]]);
    expect(read.trees[0]?.quests).toMatchObject([{ id: "q1", leadId: ALDRIC }]);
    expect(read.cursor).toBe(Schema.decodeUnknownSync(TaskTreeRead)((await get("/api/tasks/campaign")).body).cursor);

    expect(await get("/api/threads/nope/tasks")).toEqual({
      status: 404,
      body: { _tag: "ThreadNotFound", threadId: "nope" },
    });
  });

  // covers OR-004, PE-006
  it("[TC-OR-012] records your answer to a question that reached you, once, from the app only", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* quest;
        const tasks = yield* TaskRepository;
        // Aldric leads the top Quest, so no lead is above him and his question comes to you.
        yield* tasks.askQuestion({
          id: QuestionId.make("q-ship"),
          taskId: TaskId.make("campaign"),
          askerId: ALDRIC,
          text: "Ship on Friday?",
          createdAt: now,
        });
      }),
    );
    const app = "http://localhost:4390";

    expect((await post("/api/questions/q-ship/answer", { answer: "Yes" })).status).toBe(403);
    const answered = await post("/api/questions/q-ship/answer", { answer: "Yes" }, app);
    expect(answered).toMatchObject({
      status: 200,
      body: { id: "q-ship", state: "answered", answer: "Yes", answeredBy: { _tag: "User" } },
    });
    expect(await post("/api/questions/q-ship/answer", { answer: "No" }, app)).toEqual({
      status: 409,
      body: { _tag: "QuestionClosed", questionId: "q-ship" },
    });
    expect(await post("/api/questions/nope/answer", { answer: "No" }, app)).toEqual({
      status: 404,
      body: { _tag: "QuestionNotFound", questionId: "nope" },
    });
    const events = await runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EventJournal;
        return yield* journal.readAfter(-1);
      }),
    );
    expect(events.filter((entry) => entry.type === "QuestionAnswered")).toHaveLength(1);
  });

  // covers OR-007
  it("[TC-OR-007] answers 404 for a Task or Quest that is not there", async () => {
    expect(await get("/api/tasks/nope")).toEqual({ status: 404, body: { _tag: "TaskNotFound", taskId: "nope" } });
    expect(await get("/api/quests/nope")).toEqual({ status: 404, body: { _tag: "QuestNotFound", questId: "nope" } });
  });
  // covers OR-001, UX-001, CH-005
  it("[TC-OR-022] reads a hob's work on other hobs' Quests, and answers 404 for a hob that is not there", async () => {
    await runtime.runPromise(quest);

    const response = await get("/api/agents/quill/quest-work");
    expect(response.status).toBe(200);
    const read = Schema.decodeUnknownSync(MemberWorkRead)(response.body);
    expect(read.work).toMatchObject([
      {
        task: { id: "copy", ownerId: QUILL, state: "queued" },
        delegation: { leadId: ALDRIC, brief: "Draft the copy" },
        quest: { id: "q1", leadId: ALDRIC, threadId, state: "active" },
        threadAgentId: ALDRIC,
      },
    ]);
    expect(Schema.decodeUnknownSync(MemberWorkRead)((await get("/api/agents/aldric/quest-work")).body).work).toEqual(
      [],
    );
    expect(await get("/api/agents/nope/quest-work")).toEqual({
      status: 404,
      body: { _tag: "AgentNotFound", agentId: "nope" },
    });
  });
});

describe("Backpack reads", () => {
  // covers IN-001
  it("[TC-IN-026] reads a hob's, a Quest's and the workspace's open backpack items with a cursor, and answers 404 for what is not there", async () => {
    const copy = await runtime.runPromise(quest);
    const read = async (path: string) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      return Schema.decodeUnknownSync(BackpackRead)(response.body);
    };

    const quill = await read("/api/agents/quill/backpack");
    expect(quill.items.map((item) => [item.recipientId, item.kind, item.taskId, item.state])).toEqual([
      [QUILL, "task", "copy", "pending"],
    ]);
    expect(quill.items[0]?.payload).toMatchObject({ _tag: "task", delegation: { brief: "Draft the copy" } });
    expect((await read("/api/agents/aldric/backpack")).items).toEqual([]);
    expect((await read("/api/quests/q1/backpack")).items).toEqual(quill.items);
    const workspace = await read("/api/backpack");
    expect(workspace.items).toEqual(quill.items);

    // A change after the read is exactly what the stream replays after the read's cursor.
    const moved = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        return yield* tasks.moveTask(copy.value.id, copy.value.revision, "cancelled", now);
      }),
    );
    const replayed: ReadonlyArray<EventEnvelope> = await runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EventJournal;
        return yield* journal.readAfter(parseCursor(workspace.cursor)?.sequence ?? -1);
      }),
    );
    expect(replayed.map((entry) => entry.sequence)).toEqual(moved.entries.map((entry) => entry.sequence));
    expect((await read("/api/agents/aldric/backpack")).items.map((item) => item.kind)).toEqual(["failure"]);

    expect((await get("/api/agents/nobody/backpack")).status).toBe(404);
    expect((await get("/api/quests/q-none/backpack")).status).toBe(404);
  });
});
