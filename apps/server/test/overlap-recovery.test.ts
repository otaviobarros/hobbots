import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityRecorder,
  ActivityRepository,
  type FileChangeDraft,
  HobbotsRepository,
  HobTools,
  makeRedactor,
  type RuntimeEvent,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  DEFAULT_ACTIVITY_LIMITS,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  EMPTY_HOB_POLICY,
  FileChangeId,
  QuestId,
  TaskId,
  type TaskToolDone,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { TaskTools } from "@hobbots/orchestration";
import {
  ActivityRepositoryLive,
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { ActivityStoreLive, FolderScannerLive } from "@hobbots/workbench";
import { Effect, Layer, ManagedRuntime, Option, Schedule, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { OverlappingChanges } from "../src/workbench.ts";

// Issue #570, after review: a member's turn completes its Task before the turn's last scan records
// what it changed, and the hub can stop between recording changes and recording their finding.
// Neither loses the finding: the hub's own recorder, complete_task and the overlap layer, with the
// records on SQLite or PostgreSQL (TestDatabase).

const now = "2026-11-03T01:06:00.000Z";
const FRODO = AgentId.make("frodo");
const ROOK = AgentId.make("rook");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("badge");
const LEAD = TaskId.make("site");
const ROOK_TASK = TaskId.make("make-badge");
const PIP_TASK = TaskId.make("review");
const ROOK_ATTEMPT = AttemptId.make("rook-1");
const PIP_ATTEMPT = AttemptId.make("pip-1");

let work: string;
let shop: string;

const ShopTools = Layer.sync(HobTools, () =>
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [shop],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(work, "data"),
          restrictions: [],
        },
        folders: [shop],
        runtimeFolder: join(work, "runtime", agent.id),
      }),
  }),
);

const Records = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  ActivityRepositoryLive,
  BackpackLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(EventBus.layer), Layer.provideMerge(TestDatabase));

/** The hub as it runs: the overlap layer listening, the recorder and the Task tools. */
const Hub = Layer.mergeAll(OverlappingChanges, TaskTools.layer("/")).pipe(
  Layer.provideMerge(
    ActivityRecorder.layer(DEFAULT_ACTIVITY_LIMITS).pipe(
      Layer.provideMerge(
        Layer.merge(
          FolderScannerLive,
          Layer.suspend(() => ActivityStoreLive(join(work, "store"))),
        ),
      ),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeFolderChecks, ShopTools, FakeRuntimeLayer())),
  Layer.provideMerge(Records),
);

const runtimes: Array<ManagedRuntime.ManagedRuntime<never, unknown>> = [];

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-overlap-")));
  shop = join(work, "shop");
  mkdirSync(join(shop, "web"), { recursive: true });
  writeFileSync(join(shop, "web", "badge.png"), "grey");
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  rmSync(work, { recursive: true, force: true });
});

const start = <R, E>(layer: Layer.Layer<R, E>) => {
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime as never);
  return <A, F>(effect: Effect.Effect<A, F, R>) => runtime.runPromise(effect);
};

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Builder",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Frodo's Quest with Rook making the badge and Pip reviewing, both at work in the shop. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [FRODO, "Frodo"],
    [ROOK, "Rook"],
    [PIP, "Pip"],
  ] as const)
    yield* repo.insertAgent(hob(id, name));
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: FRODO, title: "Badge", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  yield* tasks.createTask({
    task: {
      id: LEAD,
      ownerId: FRODO,
      parentId: null,
      threadId,
      brief: "Build the shop",
      dependsOn: [],
      createdAt: now,
    },
    delegation: null,
    milestones: [],
  });
  yield* tasks.startQuest({
    id: QuestId.make("q-shop"),
    taskId: LEAD,
    goal: "A shop with a badge",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  for (const [taskId, ownerId, attemptId] of [
    [ROOK_TASK, ROOK, ROOK_ATTEMPT],
    [PIP_TASK, PIP, PIP_ATTEMPT],
  ] as const) {
    const created = yield* tasks.createTask({
      task: {
        id: taskId,
        ownerId,
        parentId: LEAD,
        threadId,
        brief: `Brief for ${taskId}`,
        dependsOn: [],
        createdAt: now,
      },
      delegation: {
        id: DelegationId.make(`d-${taskId}`),
        brief: `Brief for ${taskId}`,
        expectedOutput: null,
        authority: { overrides: {}, folders: null },
        timeoutMs: null,
      },
      milestones: [],
    });
    yield* tasks.startAttempt(taskId, created.value.revision, {
      id: attemptId,
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: now,
    });
  }
});

/** Pip's turn takes up his Task, as the member runner does: its item in his backpack is consumed. */
const takeUp = Effect.gen(function* () {
  const backpack = yield* Backpack;
  for (const item of yield* backpack.listOpen({ _tag: "Hob", agentId: PIP })) {
    const claimed = yield* backpack.claim(item.id, "turn", "1 minute");
    yield* backpack.resolve(
      item.id,
      { owner: "turn", token: claimed.value.fencingToken },
      { _tag: "consumed", by: "turn" },
    );
  }
});

/** Rook's earlier turn changed the badge: saved, as the recorder saves a turn's changes. */
const rookChanged = (recordedAt: string) =>
  Effect.gen(function* () {
    const draft: FileChangeDraft = {
      id: FileChangeId.make("rook-badge"),
      path: "web/badge.png",
      kind: "edited",
      movedFrom: null,
      before: { hash: "grey", size: 4, kind: "image", contentId: null, notKept: "unreadable" },
      after: { hash: "green", size: 5, kind: "image", contentId: null, notKept: "unreadable" },
      sharedWith: [],
      settled: true,
      recordedAt,
    };
    yield* (yield* ActivityRepository).saveChanges(ROOK_ATTEMPT, shop, [draft]);
  });

const findings = Effect.gen(function* () {
  const tree = Option.getOrThrow(yield* (yield* TaskRepository).readTree(LEAD));
  return tree.checkpoints.filter((each) => each.kind === "finding");
});

const findingsWhen = (count: number) =>
  findings.pipe(
    Effect.flatMap((found) => (found.length >= count ? Effect.succeed(found) : Effect.fail("not yet"))),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 150 }),
  );

describe("A finding on two Tasks changing the same file", () => {
  // covers OR-004
  it("[TC-OR-289] is recorded when a member's turn completes its Task before its last scan records the change", async () => {
    const run = start(Hub);
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* takeUp;
        yield* rookChanged(new Date().toISOString());
        // Pip's turn rewrites the badge Rook is still working on, then completes its own Task. The
        // turn's last scan, as its scope closes, is what records the change.
        const done = yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* (yield* ActivityRecorder).forTurn({
              folders: [shop],
              attempt: Effect.succeed(PIP_ATTEMPT),
              redactor: makeRedactor(),
            });
            const badge = join(shop, "web", "badge.png");
            // Pip's Edit names the badge and rewrites it, as Claude Code's would.
            yield* Stream.runDrain(
              turn.run(
                {
                  prompt: "",
                  sessionId: null,
                  instructions: "",
                  instructionsChanged: false,
                  model: null,
                  effort: null,
                  tools: null,
                  recordToolStart: () => Effect.succeed(true),
                },
                (request) =>
                  Stream.fromIterable<RuntimeEvent>([
                    {
                      _tag: "ToolStarted",
                      id: "edit",
                      tool: "Edit",
                      operation: "edit-files",
                      targets: [badge],
                      label: "Editing web/badge.png",
                    },
                  ]).pipe(
                    Stream.tap((event) =>
                      event._tag === "ToolStarted" && request.recordToolStart
                        ? request.recordToolStart(event)
                        : Effect.void,
                    ),
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.sync((): RuntimeEvent => {
                          writeFileSync(badge, "grey-again");
                          return { _tag: "ToolFinished", id: "edit", failed: false };
                        }),
                      ),
                    ),
                  ),
              ),
            );
            const tools = yield* TaskTools;
            return (yield* tools.call({ agentId: PIP, taskId: PIP_TASK }, "complete_task", {
              key: "done",
              task_id: PIP_TASK,
              summary: "Shop reviewed",
            })) as TaskToolDone;
          }),
        );
        const tree = Option.getOrThrow(yield* (yield* TaskRepository).readTree(LEAD));
        return { done, pip: tree.tasks.find((each) => each.id === PIP_TASK), found: yield* findingsWhen(1) };
      }),
    );
    expect(result.pip?.state).toBe("completed");
    expect(result.found).toHaveLength(1);
    // Pip's Task has ended, so the finding sits on Rook's, which is still at work, and names Pip's.
    expect(result.found[0]).toMatchObject({ taskId: ROOK_TASK, aboutTaskId: PIP_TASK, source: "automatic" });
    expect(result.found[0]?.summary).toContain("Pip changed web/badge.png");
  });

  // covers OR-004
  it("[TC-OR-290] is recorded when the hub starts again after it stopped before recording it", async () => {
    // The hub records both changes and stops before the finding: no overlap layer is listening.
    const run = start(Records);
    /** The overlap layer as the hub starts it, until `then` is done. */
    const restarted = <A, E, R>(then: Effect.Effect<A, E, R>) =>
      Effect.scoped(Effect.andThen(Layer.build(OverlappingChanges), then));
    const { found, again } = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* rookChanged("2026-11-03T01:06:01.000Z");
        yield* (yield* ActivityRepository).saveChanges(PIP_ATTEMPT, shop, [
          {
            id: FileChangeId.make("pip-badge"),
            path: "web/badge.png",
            kind: "edited",
            movedFrom: null,
            before: null,
            after: { hash: "grey-again", size: 10, kind: "image", contentId: null, notKept: "unreadable" },
            sharedWith: [],
            settled: true,
            recordedAt: "2026-11-03T01:06:02.000Z",
          },
        ]);
        expect(yield* findings).toEqual([]);
        // As the hub starts again, it looks over what was recorded, once however often it starts.
        const found = yield* restarted(findingsWhen(1));
        const again = yield* restarted(Effect.andThen(Effect.sleep("200 millis"), findings));
        return { found, again };
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ taskId: PIP_TASK, aboutTaskId: ROOK_TASK });
    expect(again).toHaveLength(1);
  });
});
