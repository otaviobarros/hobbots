import {
  ActivityRepository,
  EventPublisher,
  type FileChangeDraft,
  HobbotsRepository,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type Checkpoint,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  FileChangeId,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import {
  ActivityRepositoryLive,
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer, ManagedRuntime, Option, Schedule } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { OverlappingChanges } from "../src/workbench.ts";

// Issue #570: two members of a Quest share their lead's folders, so nothing kept one from
// overwriting a file the other was still working on. Now a change one member's turn records to a
// file another unfinished Task changed is one finding for their lead, on both Tasks, with the hub's
// own composition of the bus and the records on SQLite or PostgreSQL (TestDatabase).

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
const project = "/work/test";

const Hub = OverlappingChanges.pipe(
  Layer.provideMerge(
    Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, ActivityRepositoryLive, BackpackLive, EventJournal.layer),
  ),
  Layer.provideMerge(EventBus.layer),
  Layer.provideMerge(TestDatabase),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof Hub>, Layer.Error<typeof Hub>> | null = null;
afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof Hub>>) => {
  const hub = runtime ?? ManagedRuntime.make(Hub);
  runtime = hub;
  return hub.runPromise(effect);
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

const member = (id: TaskId, ownerId: AgentId) => ({
  task: { id, ownerId, parentId: LEAD, threadId, brief: `Brief for ${id}`, dependsOn: [], createdAt: now },
  delegation: {
    id: DelegationId.make(`d-${id}`),
    brief: `Brief for ${id}`,
    expectedOutput: null,
    authority: { overrides: {}, folders: null },
    timeoutMs: null,
  },
  milestones: [],
});

/** Frodo's Quest with Rook making the badge and Pip reviewing, both at work in the same folder. */
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
      brief: "Build the site",
      dependsOn: [],
      createdAt: now,
    },
    delegation: null,
    milestones: [],
  });
  yield* tasks.startQuest({
    id: QuestId.make("q-site"),
    taskId: LEAD,
    goal: "A site with a badge",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  for (const [taskId, ownerId, attemptId] of [
    [ROOK_TASK, ROOK, ROOK_ATTEMPT],
    [PIP_TASK, PIP, PIP_ATTEMPT],
  ] as const) {
    const created = yield* tasks.createTask(member(taskId, ownerId));
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

/** A change a scan recorded `second` seconds into the Quest. */
const change = (attempt: string, path: string, hash: string, second = 0): FileChangeDraft => ({
  id: FileChangeId.make(`${attempt}-${path}`),
  path,
  kind: "edited",
  movedFrom: null,
  before: { hash: "grey", size: 10, kind: "image", contentId: null, notKept: "unreadable" },
  after: { hash, size: 10, kind: "image", contentId: null, notKept: "unreadable" },
  sharedWith: [],
  settled: false,
  recordedAt: new Date(Date.parse(now) + 1000 * second).toISOString(),
});

/** Records a turn's changes as the recorder does: saved with their event, then published. */
const record = (attemptId: AttemptId, folder: string, changes: ReadonlyArray<FileChangeDraft>) =>
  Effect.gen(function* () {
    const saved = yield* (yield* ActivityRepository).saveChanges(attemptId, folder, changes);
    if (Option.isSome(saved)) yield* (yield* EventPublisher).publish(saved.value.entries);
  });

const findings = Effect.gen(function* () {
  const tree = yield* (yield* TaskRepository).readTree(LEAD);
  return Option.getOrThrow(tree).checkpoints.filter((each) => each.kind === "finding");
});

/** The findings once there are `count`, read until they appear: the hub records them as it hears the changes. */
const findingsWhen = (count: number) =>
  findings.pipe(
    Effect.flatMap((found) => (found.length >= count ? Effect.succeed(found) : Effect.fail("not yet"))),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
  );

/** Lets the hub hear every change published so far, so a finding that should not exist would have. */
const settle = Effect.sleep("200 millis");

describe("Two Tasks of a Quest changing the same file", () => {
  // covers OR-004
  it("[TC-OR-280] is one finding for the lead, on the Task that changed it and about the other, however often it is recorded", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* record(ROOK_ATTEMPT, project, [change("rook", "web/badge.png", "rook-1")]);
        yield* settle;
        const before = yield* findings;
        // Pip's review regenerates the badge, and the turn records it once while it runs and again at its end.
        yield* record(PIP_ATTEMPT, project, [
          change("pip", "web/badge.png", "pip-1", 1),
          change("pip", "notes.md", "n", 1),
        ]);
        yield* record(PIP_ATTEMPT, project, [
          change("pip", "web/badge.png", "pip-2", 2),
          change("pip", "notes.md", "n", 2),
        ]);
        const [finding] = yield* findingsWhen(1);
        // Rook's next scan sees the badge as changed again: the pair already has its finding.
        yield* record(ROOK_ATTEMPT, project, [change("rook", "web/badge.png", "rook-2", 3)]);
        yield* settle;
        const all = yield* findings;
        const lead = yield* (yield* Backpack).listOpen({ _tag: "Hob", agentId: FRODO });
        return { before, finding: finding as Checkpoint, all, lead };
      }),
    );
    expect(result.before).toEqual([]);
    expect(result.all).toHaveLength(1);
    expect(result.finding).toMatchObject({
      taskId: PIP_TASK,
      aboutTaskId: ROOK_TASK,
      source: "automatic",
      kind: "finding",
      attemptId: PIP_ATTEMPT,
    });
    expect(result.finding.summary).toContain("web/badge.png");
    expect(result.finding.summary).toContain("Pip changed");
    expect(result.finding.summary).toContain(`Rook's Task ${ROOK_TASK}`);
    const checkpoints = result.lead.filter((item) => item.payload._tag === "checkpoint");
    expect(checkpoints.map((item) => item.taskId)).toEqual([PIP_TASK]);
  });

  // covers OR-004
  it("[TC-OR-281] compares full paths, so a member working in a folder inside its lead's is seen too", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* record(ROOK_ATTEMPT, project, [change("rook", "web/badge.png", "rook-1")]);
        yield* record(PIP_ATTEMPT, `${project}/web`, [change("pip", "badge.png", "pip-1", 1)]);
        return yield* findingsWhen(1);
      }),
    );
    expect(result.map((each) => [each.taskId, each.aboutTaskId])).toEqual([[PIP_TASK, ROOK_TASK]]);
  });

  // covers OR-004
  it("[TC-OR-282] is no finding for different files, or once the other Task has ended", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* TaskRepository;
        yield* record(ROOK_ATTEMPT, project, [change("rook", "web/badge.png", "rook-1")]);
        yield* record(PIP_ATTEMPT, project, [change("pip", "web/index.html", "pip-1", 1)]);
        yield* settle;
        const apart = yield* findings;
        const ended = yield* tasks.updateAttempt(ROOK_ATTEMPT, { state: "failed", at: now });
        yield* tasks.moveTask(ROOK_TASK, ended.value.task.revision, "failed", now);
        yield* record(PIP_ATTEMPT, project, [change("pip", "web/badge.png", "pip-2", 2)]);
        yield* settle;
        return { apart, ended: yield* findings };
      }),
    );
    expect(result.apart).toEqual([]);
    expect(result.ended).toEqual([]);
  });
});
