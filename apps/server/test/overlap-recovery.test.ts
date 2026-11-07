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
  type TurnActivity,
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
  MessageId,
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
        commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
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

/** A turn on `attempt` in the shop, its baseline taken now; its last scan runs as its scope closes. */
const openTurn = (attempt: Effect.Effect<AttemptId | null>) =>
  Effect.flatMap(Effect.service(ActivityRecorder), (recorder) =>
    recorder.forTurn({ folders: [shop], attempt, redactor: makeRedactor() }),
  );

/** `turn` runs a file tool on the badge, `act` making the change as it runs. */
const changeBadge = (turn: TurnActivity, operation: "edit-files" | "delete-files", act: (badge: string) => void) => {
  const badge = join(shop, "web", "badge.png");
  return Stream.runDrain(
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
          { _tag: "ToolStarted", id: "tool", tool: "Edit", operation, targets: [badge], label: "Changing the badge" },
        ]).pipe(
          Stream.tap((event) =>
            event._tag === "ToolStarted" && request.recordToolStart ? request.recordToolStart(event) : Effect.void,
          ),
          Stream.concat(
            Stream.fromEffect(
              Effect.sync((): RuntimeEvent => {
                act(badge);
                return { _tag: "ToolFinished", id: "tool", failed: false };
              }),
            ),
          ),
        ),
    ),
  );
};

/**
 * One turn on `attempt` that runs a file tool on the badge, `act` making the change as it runs, then
 * `after` while the turn is still live. The turn's last scan runs as its scope closes.
 */
const turnOnBadge = <A, E, R>(
  attempt: Effect.Effect<AttemptId | null>,
  operation: "edit-files" | "delete-files",
  act: (badge: string) => void,
  after: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* changeBadge(yield* openTurn(attempt), operation, act);
      return yield* after;
    }),
  );

describe("A finding on two Tasks changing the same file", () => {
  // Issue #658: the lead's turn clears the badge, delegates Pip at once, before the delete's own
  // rescan may have run, and ends with the badge still gone, so its last scan sees the delete again
  // after Pip's Task exists. Pip then makes the badge anew: no finding, however the lead delegated.
  const LEAD_ATTEMPT = AttemptId.make("frodo-1");

  /** Frodo's Attempt on his root Task, as a turn briefed on it runs. */
  const leadAtWork = Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const root = Option.getOrThrow(yield* tasks.readTree(LEAD)).tasks[0];
    yield* tasks.startAttempt(LEAD, root?.revision ?? 0, {
      id: LEAD_ATTEMPT,
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: new Date().toISOString(),
    });
  });

  /** Pip's turn on the Task `rootId`'s lead delegated to rebuild the badge; then what was recorded. */
  const rebuilt = (rootId: TaskId) => Effect.andThen(pipRebuilds(rootId), recorded(rootId));

  /** Pip's turn on the Task `rootId`'s lead delegated to rebuild the badge: it makes the badge anew. */
  const pipRebuilds = (rootId: TaskId) =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const rebuild = Option.getOrThrow(yield* tasks.readTree(rootId)).tasks.find(
        (each) => each.ownerId === PIP && each.id !== PIP_TASK,
      );
      if (rebuild === undefined) return yield* Effect.die("Pip's Task was not delegated");
      const attempt = AttemptId.make("pip-rebuild-1");
      yield* tasks.startAttempt(rebuild.id, rebuild.revision, {
        id: attempt,
        runtime: "claude-code",
        sessionId: null,
        configVersion: 1,
        policyVersion: null,
        startedAt: new Date().toISOString(),
      });
      yield* turnOnBadge(Effect.succeed(attempt), "edit-files", (badge) => writeFileSync(badge, "green"), Effect.void);
    });

  /** What was recorded on the tree of `rootId`, once the hub has heard every change. */
  const recorded = (rootId: TaskId) =>
    Effect.gen(function* () {
      yield* Effect.sleep("300 millis");
      const tree = Option.getOrThrow(yield* (yield* TaskRepository).readTree(rootId));
      const rebuild = tree.tasks.find((each) => each.ownerId === PIP && each.id !== PIP_TASK);
      const lead = tree.tasks[0]?.currentAttemptId;
      if (rebuild === undefined || !lead) return yield* Effect.die("Pip's Task was not delegated");
      const leads = Option.getOrThrow(yield* (yield* ActivityRepository).read(lead)).changes;
      return { rebuild, leads, found: tree.checkpoints.filter((each) => each.kind === "finding") };
    });

  /**
   * The lead's delete kept the time it was first seen, no later than Pip's Task was delegated (the
   * same millisecond counts as before), and nothing was found.
   */
  const expectNoFinding = (result: Effect.Success<ReturnType<typeof recorded>>) => {
    expect(result.leads.map((each) => [each.path, each.kind, each.recordedAt <= result.rebuild.createdAt])).toEqual([
      ["web/badge.png", "deleted", true],
    ]);
    expect(result.found).toEqual([]);
  };

  // covers OR-004
  it.each([
    ["TC-OR-412", "naming the Task to delegate under", { task_id: LEAD }],
    ["TC-OR-413", "leaving out the Task, so it is the caller's own", {}],
  ])("[%s] is not recorded for a file the lead deleted before it delegated, %s", async (_id, _how, named) => {
    const run = start(Hub);
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* leadAtWork;
        yield* turnOnBadge(
          Effect.succeed(LEAD_ATTEMPT),
          "delete-files",
          (badge) => rmSync(badge),
          (yield* TaskTools).call({ agentId: FRODO, taskId: LEAD }, "delegate_task", {
            key: "rebuild",
            ...named,
            hob: "Pip",
            brief: "Make the badge again",
          }),
        );
        return yield* rebuilt(LEAD);
      }),
    );
    expectNoFinding(result);
  });

  // covers OR-004
  it("[TC-OR-415] is not recorded when the member makes the file again while the lead's turn still runs", async () => {
    // The lead's last scan then sees the badge Pip made, not the one it deleted: that is Pip's
    // change, and the lead's stays the delete it made before it delegated.
    const run = start(Hub);
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* leadAtWork;
        yield* turnOnBadge(
          Effect.succeed(LEAD_ATTEMPT),
          "delete-files",
          (badge) => rmSync(badge),
          Effect.gen(function* () {
            yield* (yield* TaskTools).call({ agentId: FRODO, taskId: LEAD }, "delegate_task", {
              key: "rebuild",
              hob: "Pip",
              brief: "Make the badge again",
            });
            yield* pipRebuilds(LEAD);
          }),
        );
        return yield* recorded(LEAD);
      }),
    );
    expectNoFinding(result);
  });

  // covers OR-004
  it("[TC-OR-414] is not recorded for a file a chat turn deleted before the delegation that starts its Task", async () => {
    const run = start(Hub);
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        // A thread with no Task yet: the delegation starts Frodo's Task and his turn's Attempt on it.
        const elsewhere = ThreadId.make("rebuild");
        yield* (yield* HobbotsRepository).upsertThread(
          new Thread({ id: elsewhere, agentId: FRODO, title: "Rebuild", createdAt: now, updatedAt: now }),
        );
        const chat = yield* (yield* TaskTools).forChat({
          agentId: FRODO,
          threadId: elsewhere,
          messageId: MessageId.make("rebuild-1"),
          prompt: "Clear the badge, then have Pip make it again",
          runtime: "claude-code",
          configVersion: 1,
        });
        const answer = yield* turnOnBadge(
          chat.attempt,
          "delete-files",
          (badge) => rmSync(badge),
          chat.hubTools.call("delegate_task", { key: "rebuild", hob: "Pip", brief: "Make the badge again" }),
        );
        expect(answer.refused).toBe(false);
        const rootId = yield* chat.workingOn;
        if (rootId === null) return yield* Effect.die("The delegation started no Task");
        return yield* rebuilt(rootId);
      }),
    );
    expectNoFinding(result);
  });

  // covers OR-004
  it("[TC-OR-416] is recorded when one member overwrites the other's file before the other's turn scanned it", async () => {
    // Rook's edit to the badge is not on the record yet when Pip's edit takes the file over: Rook's
    // change is still his, so the two edits are one finding.
    const run = start(Hub);
    const found = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* takeUp;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const rook = yield* openTurn(Effect.succeed(ROOK_ATTEMPT));
            const pip = yield* openTurn(Effect.succeed(PIP_ATTEMPT));
            yield* changeBadge(rook, "edit-files", (badge) => writeFileSync(badge, "rook"));
            yield* changeBadge(pip, "edit-files", (badge) => writeFileSync(badge, "pip"));
          }),
        );
        return yield* findingsWhen(1);
      }),
    );
    expect(found.map((each) => [each.taskId, each.aboutTaskId].sort())).toEqual([[ROOK_TASK, PIP_TASK].sort()]);
  });

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
              delivered: true,
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
    // complete_task has Pip's edit recorded first, and the finding is heard as it is: on Pip's Task
    // when it is heard before his Task ends, else on Rook's, still at work. Either names the other.
    const pair = [result.found[0]?.taskId, result.found[0]?.aboutTaskId].sort();
    expect(pair).toEqual([ROOK_TASK, PIP_TASK].sort());
    expect(result.found[0]?.source).toBe("automatic");
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
