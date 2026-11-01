import {
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type Message,
  type Task,
  TaskId,
  type TaskTree,
  type ThreadId,
} from "@hobbots/domain";
import { type StepLimits, StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Layer, ManagedRuntime, Option, Schedule, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// A Task's steps of ADR 018, from a chat turn through the step runner to the owner's next turn,
// with the fake runtime and steps the test lets finish one at a time.

const now = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const STEP_MARK = "This is step ";

/** The fake runtime, except that a step's session waits until the test lets it go, by its brief's first line. */
interface Gates {
  readonly requests: Array<PromptRequest>;
  readonly open: (name: string) => Effect.Effect<void>;
  readonly waiting: () => ReadonlyArray<string>;
}

const gated = (gates: Map<string, Deferred.Deferred<void>>, requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          if (!request.prompt.includes(STEP_MARK)) return fake.sendPrompt(request);
          const name = request.prompt.split("\n")[0] ?? "";
          return Stream.unwrap(
            Effect.gen(function* () {
              const gate = gates.get(name) ?? (yield* Deferred.make<void>());
              gates.set(name, gate);
              yield* Deferred.await(gate);
              return fake.sendPrompt(request);
            }),
          );
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

/** What the hub's records hold before it starts, as after a restart. */
type Before = Layer.Layer<never, never, HobbotsRepository | TaskRepository>;

const makeApp = (
  limits: StepLimits,
  gates: Map<string, Deferred.Deferred<void>>,
  requests: Array<PromptRequest>,
  before: Before,
) =>
  ChatService.layer.pipe(
    Layer.provideMerge(
      StepRunnerLive(limits).pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(before),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        HobTools.chatOnly,
        HobAdmission.layer,
        gated(gates, requests),
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

const setUp = (
  limits: StepLimits = { maxRunningStepsPerHob: 2, maxRunningStepsPerTree: 3 },
  before: Before = Layer.empty,
) => {
  const gates = new Map<string, Deferred.Deferred<void>>();
  const requests: Array<PromptRequest> = [];
  const app = ManagedRuntime.make(makeApp(limits, gates, requests, before));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  const gate = (name: string) =>
    Effect.gen(function* () {
      const existing = gates.get(name);
      if (existing !== undefined) return existing;
      const made = yield* Deferred.make<void>();
      gates.set(name, made);
      return made;
    });
  const stepsAsked = () => requests.filter((request) => request.prompt.includes(STEP_MARK));
  const control: Gates = {
    requests,
    open: (name) => Effect.flatMap(gate(name), (made) => Deferred.succeed(made, undefined)),
    // Steps whose session asked to start and still waits for the test.
    waiting: () =>
      stepsAsked()
        .map((request) => request.prompt.split("\n")[0] ?? "")
        .filter((name) => {
          const made = gates.get(name);
          return made !== undefined && !Deferred.isDoneUnsafe(made);
        }),
  };
  return { run, control, stepsAsked };
};

const insertAldric = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: ALDRIC,
      name: "Aldric",
      roleTitle: "Chief of marketing",
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
});

const seed = Effect.andThen(
  insertAldric,
  ChatService.use((chat) => chat.createThread(ALDRIC)),
);

/** A prompt line that makes the fake call a Task tool with `input`. */
const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));

/** The thread's latest reply once it has ended. */
const reply = (threadId: ThreadId) =>
  retry(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const last = (yield* repo.listMessages(threadId)).at(-1);
      return last?.role === "assistant" && last.status !== "streaming" && last.status !== "stopping"
        ? last
        : yield* Effect.fail("still streaming" as const);
    }),
  );

const send = (threadId: ThreadId, prompt: string) =>
  Effect.gen(function* () {
    yield* ChatService.use((chat) => chat.sendPrompt(threadId, prompt));
    return (yield* reply(threadId)) as Message;
  });

/** The thread's one Task tree, once `ready` holds for it. */
const treeWhen = (threadId: ThreadId, ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      return tree !== undefined && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

const stepsOf = (tree: TaskTree) => tree.tasks.slice(1);
const states = (tree: TaskTree) => stepsOf(tree).map((step) => step.state);
/** The step a card shows: the first that has not ended, from 1, out of all of them. */
const shown = (tree: TaskTree) => {
  const steps = stepsOf(tree);
  const index = steps.findIndex((step) => step.state !== "completed");
  return `step ${(index === -1 ? steps.length - 1 : index) + 1} of ${steps.length}`;
};

const chain = (briefs: ReadonlyArray<string>) =>
  briefs.map((brief, index) => (index === 0 ? { brief } : { brief, after: [index] }));

describe("a Task's steps in fresh sessions", () => {
  // covers OR-001, OR-005, EX-001
  it("[TC-OR-025] a Task split into four steps shows step 2 of 4 and finishes with one result", async () => {
    const { run, control, stepsAsked } = setUp();
    const thread = await run(seed);
    const briefs = ["Outline the campaign", "Write the copy", "Pick the images", "Proofread everything"];
    await run(
      send(thread.id, `Plan the Black Friday launch\n${hub("plan_steps", { key: "plan", steps: chain(briefs) })}`),
    );

    // The request became a Task with four steps; only the first runs.
    const first = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "active"));
    expect(first.tasks[0]?.brief).toBe(
      `Plan the Black Friday launch\n${hub("plan_steps", { key: "plan", steps: chain(briefs) })}`,
    );
    expect(states(first)).toEqual(["active", "queued", "queued", "queued"]);
    expect(shown(first)).toBe("step 1 of 4");

    await run(control.open("Outline the campaign"));
    const second = await run(treeWhen(thread.id, (tree) => states(tree)[1] === "active"));
    expect(states(second)).toEqual(["completed", "active", "queued", "queued"]);
    expect(shown(second)).toBe("step 2 of 4");

    for (const brief of briefs.slice(1)) await run(control.open(brief));
    const ended = await run(treeWhen(thread.id, (tree) => states(tree).every((state) => state === "completed")));
    expect(ended.tasks[0]?.state).toBe("active");

    // Every step ran in a session of its own, from its brief, never the thread's.
    const asked = stepsAsked();
    expect(asked.map((request) => request.prompt.split("\n")[0])).toEqual(briefs);
    expect(asked.every((request) => request.sessionId === null && request.briefing === null)).toBe(true);
    const sessions = ended.attempts.filter((each) => each.taskId !== ended.tasks[0]?.id).map((each) => each.sessionId);
    expect(new Set(sessions).size).toBe(4);
    const threadSession = (await run(HobbotsRepository.use((repo) => repo.findThread(thread.id)))).pipe(
      Option.getOrThrow,
    ).sessions[0]?.sessionId;
    expect(sessions).not.toContain(threadSession);
    // A later step hears what the one before it returned, and nothing of the steps after it.
    const third = asked[2]?.prompt ?? "";
    expect(third).toContain("Step 2 returned:");
    expect(third).not.toContain("Proofread everything");
    expect(asked[0]?.prompt).not.toContain("returned:");

    // The owner returns one result for the Task.
    await run(send(thread.id, hub("complete_task", { key: "done", summary: "The launch plan is ready" })));
    const finished = await run(treeWhen(thread.id, (tree) => tree.tasks[0]?.state === "completed"));
    expect(finished.tasks[0]?.result?.summary).toBe("The launch plan is ready");
    expect(finished.tasks.filter((task) => task.parentId === null)).toHaveLength(1);
  });

  // covers OR-005, IN-005
  it("[TC-OR-026] the owner's session holds the steps' checkpoints and results, not their transcripts", async () => {
    const { run, control } = setUp();
    const thread = await run(seed);
    const steps = [
      {
        brief: `Research keywords\n${hub("report_checkpoint", { key: "found", kind: "finding", summary: "Shoppers search for bundles" })}\n${hub("complete_task", { key: "kw", summary: "Twelve keywords chosen" })}`,
      },
      { brief: `Draft the copy\n${hub("complete_task", { key: "copy", summary: "Copy drafted" })}` },
    ];
    await run(send(thread.id, `Write the campaign\n${hub("plan_steps", { key: "plan", steps })}`));
    await run(control.open("Research keywords"));
    await run(control.open("Draft the copy"));
    const ended = await run(treeWhen(thread.id, (tree) => states(tree).every((state) => state === "completed")));
    expect(stepsOf(ended).map((step) => step.result?.summary)).toEqual(["Twelve keywords chosen", "Copy drafted"]);
    expect(ended.checkpoints.some((each) => each.kind === "finding")).toBe(true);

    const next = await run(send(thread.id, "How did it go?"));
    const told = control.requests.at(-1)?.briefing ?? "";
    expect(told).toContain("Twelve keywords chosen");
    expect(told).toContain("Copy drafted");
    // Neither a step's prompt nor its reply reaches the owner.
    expect(told).not.toContain(STEP_MARK);
    expect(told).not.toContain("Echo:");
    expect(next.content).toContain("Copy drafted");
  });

  // covers OR-004, OR-005
  it("[TC-OR-027] steps without an order run in parallel, up to the hob's limit", async () => {
    const { run, control } = setUp({ maxRunningStepsPerHob: 2, maxRunningStepsPerTree: 3 });
    const thread = await run(seed);
    const briefs = ["Banner A", "Banner B", "Banner C"];
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps: briefs.map((brief) => ({ brief })) })));

    const two = await run(treeWhen(thread.id, (tree) => states(tree).filter((s) => s === "active").length === 2));
    expect(states(two)).toEqual(["active", "active", "queued"]);
    await run(retry(Effect.suspend(() => (control.waiting().length === 2 ? Effect.void : Effect.fail("not yet")))));

    await run(control.open("Banner B"));
    const next = await run(treeWhen(thread.id, (tree) => states(tree)[2] === "active"));
    expect(states(next)).toEqual(["active", "completed", "active"]);
    await run(control.open("Banner A"));
    await run(control.open("Banner C"));
    await run(treeWhen(thread.id, (tree) => states(tree).every((state) => state === "completed")));
  });

  // covers OR-004
  it("[TC-OR-028] the tree's limit holds steps back across its hob's limit", async () => {
    const { run } = setUp({ maxRunningStepsPerHob: 4, maxRunningStepsPerTree: 1 });
    const thread = await run(seed);
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps: [{ brief: "One" }, { brief: "Two" }] })));
    const one = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "active"));
    expect(states(one)).toEqual(["active", "queued"]);
  });

  // covers OR-005, CH-001
  it("[TC-OR-029] the owner keeps answering while its steps run", async () => {
    const { run, control } = setUp();
    const thread = await run(seed);
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps: [{ brief: "Long research" }] })));
    await run(treeWhen(thread.id, (tree) => states(tree)[0] === "active"));

    const answered = await run(send(thread.id, "Are you still there?"));
    expect(answered.status).toBe("complete");
    expect(answered.content).toContain("Are you still there?");
    expect(answered.content).toContain("Long research");
    expect(states(await run(treeWhen(thread.id, () => true)))).toEqual(["active"]);
    await run(control.open("Long research"));
    await run(treeWhen(thread.id, (tree) => states(tree)[0] === "completed"));
  });

  // covers EX-001, OR-005
  it("[TC-OR-030] a step whose session fails fails with the reason, and the steps after it wait", async () => {
    const { run, control } = setUp();
    const thread = await run(seed);
    const steps = [{ brief: "fake:cut-off the outline" }, { brief: "Write from the outline", after: [1] }];
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps })));
    await run(control.open("fake:cut-off the outline"));
    const failed = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "failed"));
    expect(states(failed)).toEqual(["failed", "queued"]);
    const attempt = failed.attempts.find((each) => each.taskId === stepsOf(failed)[0]?.id);
    expect(attempt?.state).toBe("failed");
    expect(attempt?.outcome).toBe("Claude stopped responding");

    await run(send(thread.id, "What happened?"));
    expect(control.requests.at(-1)?.briefing).toContain("failed");
  });

  // covers OR-003, EX-001
  it("[TC-OR-031] cancelling a running step stops its session and confirms the cancel", async () => {
    const { run } = setUp();
    const thread = await run(seed);
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps: [{ brief: "Slow work" }] })));
    const running = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "active"));
    const step = stepsOf(running)[0] as Task;
    await run(send(thread.id, hub("cancel_task", { key: "stop", task_id: step.id })));
    const cancelled = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "cancelled"));
    expect(cancelled.attempts.find((each) => each.taskId === step.id)?.state).toBe("cancelled");
  });

  // covers OR-001
  it("[TC-OR-032] a chat turn's report outside any Task is refused, and starts no Task", async () => {
    const { run } = setUp();
    const thread = await run(seed);
    const answer = await run(send(thread.id, hub("report_checkpoint", { key: "r", kind: "progress", summary: "x" })));
    expect(answer.content).toContain("Refused (no-task)");
    expect(await run(TaskRepository.use((tasks) => tasks.readThreadTrees(thread.id)))).toEqual([]);
  });

  // covers EX-004, EX-005
  it("[TC-OR-033] after a restart, a step that was running fails and no Attempt stays live", async () => {
    const TOP = TaskId.make("top");
    const STEP = TaskId.make("step");
    const leftRunning = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* insertAldric;
        const tasks = yield* TaskRepository;
        const attempt = (id: string) => ({
          id: AttemptId.make(id),
          runtime: "claude-code" as const,
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: now,
        });
        const base = { ownerId: ALDRIC, threadId: null, dependsOn: [], createdAt: now };
        const top = yield* tasks.createTask({
          task: { ...base, id: TOP, parentId: null, brief: "The launch" },
          delegation: null,
          milestones: [],
        });
        yield* tasks.startAttempt(TOP, top.value.revision, attempt("top-1"));
        const step = yield* tasks.createTask({
          task: { ...base, id: STEP, parentId: TOP, brief: "Write the copy" },
          delegation: null,
          milestones: [],
        });
        yield* tasks.startAttempt(STEP, step.value.revision, attempt("step-1"));
      }).pipe(Effect.orDie),
    );
    const { run } = setUp(undefined, leftRunning);
    const tree = Option.getOrThrow(await run(TaskRepository.use((tasks) => tasks.readTree(TOP))));
    expect(tree.attempts.map((each) => each.state)).toEqual(["interrupted", "interrupted"]);
    expect(tree.tasks.map((task) => task.state)).toEqual(["active", "failed"]);
  });
});
