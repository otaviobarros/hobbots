import {
  ApprovalService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type BackpackItem,
  CheckpointId,
  type CheckpointKind,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { DEFAULT_DISPATCH_LIMITS, Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option, Schedule } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { BlockOnRetirement } from "../src/blockers.ts";
import { ContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// A lead's continuations are turns of its Task's one Attempt (#577): a party's reports wake it as
// few times as they can, and however many turns that takes, the Task stays on Attempt 1.

const now = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const SAM = AgentId.make("sam");
const PIPPIN = AgentId.make("pippin");
const MERRY = AgentId.make("merry");
const threadId = ThreadId.make("shire");
const top = TaskId.make("quest");

/** Every prompt the fake runtime was sent, so a test counts the continuations. */
const recorded = (requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          return fake.sendPrompt(request);
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));

const hob = (id: AgentId, name: string, lookSeed: number) =>
  new Agent({
    id,
    name,
    roleTitle: "Hobbit",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Frodo, his thread and his party, stored before the hub starts. */
const Party = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const [index, [id, name]] of (
      [
        [FRODO, "Frodo"],
        [SAM, "Sam"],
        [PIPPIN, "Pippin"],
        [MERRY, "Merry"],
      ] as const
    ).entries()) {
      yield* repo.insertAgent(hob(id, name, index + 1));
    }
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
    );
  }),
);

const makeApp = (requests: Array<PromptRequest>) =>
  Layer.mergeAll(WakeOnArrival, BlockOnRetirement, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(
      ContinuationsLive.pipe(
        Layer.provideMerge(Dispatcher.layer(DEFAULT_DISPATCH_LIMITS)),
        Layer.provideMerge(DispatcherHostLive),
      ),
    ),
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(ApprovalService.layer),
    Layer.provideMerge(Party),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ApprovalRepositoryLive,
        BackpackLive,
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        NoTools,
        HobAdmission.layer,
        recorded(requests),
      ),
    ),
    Layer.provideMerge(TestDatabase),
  );

type App = ReturnType<typeof makeApp>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<App>, Layer.Error<App>> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

const setUp = () => {
  const requests: Array<PromptRequest> = [];
  const app = ManagedRuntime.make(makeApp(requests));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  /** The continuations Hobbots started in Frodo's thread so far. */
  const continuations = () => requests.filter((request) => request.prompt.startsWith("Hobbots wrote this"));
  return { run, continuations };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));

/** Frodo's Quest, with a Task under it for each of Sam, Pippin and Merry. */
const party = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  const task = (id: string, ownerId: AgentId, parentId: string | null) => ({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    threadId,
    brief: `Brief for ${id}`,
    dependsOn: [],
    createdAt: now,
  });
  yield* tasks.createTask({ task: task("quest", FRODO, null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("journey"),
    taskId: top,
    goal: "Reach the mountain",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  for (const [id, owner] of [
    ["cook", SAM],
    ["scout", PIPPIN],
    ["guard", MERRY],
  ] as const) {
    const delegation = {
      id: DelegationId.make(`d-${id}`),
      brief: `Do the ${id}ing`,
      expectedOutput: null,
      authority: { overrides: {}, folders: null },
      timeoutMs: null,
    };
    yield* tasks.createTask({ task: task(id, owner, "quest"), delegation, milestones: [] });
  }
});

let reports = 0;
/** Each member reports once, of `kind`: returns the items that made for Frodo. */
const everyoneReports = (kind: CheckpointKind) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const items: Array<BackpackItem> = [];
    for (const member of ["cook", "scout", "guard"]) {
      reports += 1;
      const reported = yield* tasks.recordCheckpoint({
        id: CheckpointId.make(`report-${reports}`),
        taskId: TaskId.make(member),
        source: "unplanned",
        kind,
        milestoneId: null,
        summary: `${member} report ${reports}`,
        createdAt: now,
      });
      for (const entry of reported.entries) {
        if (entry.payload._tag === "BackpackItemRecorded") items.push(entry.payload.item);
      }
    }
    return items;
  });

/** The top Task's Attempts, once every one of them has ended. */
const settledAttempts = retry(
  Effect.gen(function* () {
    const tree = Option.getOrThrow(yield* TaskRepository.use((tasks) => tasks.readTree(top)));
    const attempts = tree.attempts.filter((attempt) => attempt.taskId === top);
    return attempts.length > 0 && attempts.every((attempt) => attempt.endedAt !== null)
      ? attempts.map(({ number, agentId, state }) => ({ number, agentId, state }))
      : yield* Effect.fail("not yet" as const);
  }),
);

/** Waits until `count` continuations have run in Frodo's thread and their replies have ended. */
const replies = (count: number) =>
  retry(
    Effect.gen(function* () {
      const all = yield* HobbotsRepository.use((repo) => repo.listMessages(threadId));
      const ended = all.every((m) => m.status !== "streaming" && m.status !== "stopping");
      return ended && all.length >= count ? all : yield* Effect.fail("not yet" as const);
    }),
  );

describe("a lead's continuations and its Task's Attempts", () => {
  afterEach(() => {
    reports = 0;
  });

  // covers IN-005, EX-001, OR-003
  it("[TC-OR-313] routine progress starts no turn, findings that arrive together start one, and every continuation stays in Attempt 1", async () => {
    const { run, continuations } = setUp();
    await run(party);

    // Thirty routine updates across the party: nothing wakes Frodo.
    for (let round = 0; round < 10; round++) await run(everyoneReports("progress"));
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(Effect.sleep("150 millis"));
    expect(continuations()).toHaveLength(0);

    // Three findings recorded together: one continuation reads all three, the progress riding along.
    const findings = await run(everyoneReports("finding"));
    expect(findings.every((item) => item.recipientId === FRODO && item.actionable)).toBe(true);
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(replies(1));
    await run(Effect.sleep("150 millis"));
    expect(continuations()).toHaveLength(1);
    const first = continuations()[0]?.prompt ?? "";
    for (const member of ["cook", "scout", "guard"]) expect(first).toContain(`Task ${member}:`);
    expect(first).toContain("30 updates in all");
    expect(await run(settledAttempts)).toEqual([{ number: 1, agentId: FRODO, state: "completed" }]);

    // Another batch is another turn, of the same Attempt.
    await run(everyoneReports("finding"));
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(replies(2));
    expect(continuations()).toHaveLength(2);
    expect(await run(settledAttempts)).toEqual([{ number: 1, agentId: FRODO, state: "completed" }]);
  }, 15_000);

  // covers EX-001, OR-003
  it("[TC-OR-314] a continuation on another brain than the Attempt it would resume starts Attempt 2 instead", async () => {
    const { run, continuations } = setUp();
    await run(party);
    await run(everyoneReports("finding"));
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(replies(1));
    expect(await run(settledAttempts)).toEqual([{ number: 1, agentId: FRODO, state: "completed" }]);

    // Frodo's configuration changes between the turns: the next one is an Attempt of its own.
    await run(
      HobbotsRepository.use((repo) =>
        Effect.gen(function* () {
          const frodo = Option.getOrThrow(yield* repo.findAgent(FRODO));
          yield* repo.updateAgentConfig(new Agent({ ...frodo, instructions: "Travel light.", configVersion: 2 }));
        }),
      ),
    );
    await run(everyoneReports("finding"));
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(replies(2));
    expect(continuations()).toHaveLength(2);
    expect(await run(settledAttempts)).toEqual([
      { number: 1, agentId: FRODO, state: "completed" },
      { number: 2, agentId: FRODO, state: "completed" },
    ]);
  }, 15_000);
});
