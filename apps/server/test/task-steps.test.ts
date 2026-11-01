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
import {
  DEFAULT_TASK_TOOL_LIMITS,
  type StepLimits,
  StepRunnerLive,
  TaskSignal,
  type TaskToolLimits,
  TaskTools,
} from "@hobbots/orchestration";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Layer, ManagedRuntime, Option, Schedule, Scheduler, Stream } from "effect";
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

/** The folders every hob may work in; a test narrows them to stop the steps that had them. */
let folders: ReadonlyArray<string> = [];
/**
 * When set, the next read of a hob's access returns the folders of that moment, then waits until
 * the test lets it go, so the test can narrow the folders while a step is starting.
 */
let held: { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> } | undefined;
const accessTo = (agent: Agent, now: ReadonlyArray<string>) =>
  now.length === 0
    ? null
    : {
        policy: {
          preset: "balanced" as const,
          sharedFolders: [],
          hob: agent.policy,
          dataFolder: "/hobbots/data",
          restrictions: [],
        },
        folders: now,
        runtimeFolder: `/hobbots/runtimes/${agent.id}`,
      };
const WorkFolders = Layer.succeed(
  HobTools,
  HobTools.of({
    access: (agent) =>
      Effect.gen(function* () {
        const access = accessTo(agent, folders);
        const hold = held;
        held = undefined;
        if (hold !== undefined) {
          yield* Deferred.succeed(hold.reached, undefined);
          yield* Deferred.await(hold.release);
        }
        return access;
      }),
  }),
);

/** What the hub's records hold before it starts, as after a restart. */
type Before = Layer.Layer<never, never, HobbotsRepository | TaskRepository>;

/** How a test's hub is set up, beyond the defaults. */
interface Options {
  readonly limits?: StepLimits;
  readonly taskLimits?: TaskToolLimits;
  readonly before?: Before;
  /** How many operations a fiber runs before it lets others run. */
  readonly opsBeforeYield?: number;
}

const makeApp = (options: Options, gates: Map<string, Deferred.Deferred<void>>, requests: Array<PromptRequest>) =>
  ChatService.layer.pipe(
    Layer.provideMerge(
      StepRunnerLive(options.limits ?? { maxRunningStepsPerHob: 2, maxRunningStepsPerTree: 3 }).pipe(
        Layer.provideMerge(TaskTools.layer("/", options.taskLimits ?? DEFAULT_TASK_TOOL_LIMITS)),
        Layer.provideMerge(TaskSignal.layer),
      ),
    ),
    Layer.provideMerge(options.before ?? Layer.empty),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        WorkFolders,
        HobAdmission.layer,
        gated(gates, requests),
      ),
    ),
    Layer.provideMerge(TestDatabase),
  );

type App = ReturnType<typeof makeApp>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<App>, Layer.Error<App>> | undefined;

afterEach(async () => {
  folders = [];
  held = undefined;
  await runtime?.dispose();
  runtime = undefined;
});

const setUp = (options: Options = {}) => {
  const gates = new Map<string, Deferred.Deferred<void>>();
  const requests: Array<PromptRequest> = [];
  const layer = makeApp(options, gates, requests);
  const app = ManagedRuntime.make(
    options.opsBeforeYield === undefined
      ? layer
      : layer.pipe(Layer.provide(Layer.succeed(Scheduler.MaxOpsBeforeYield, options.opsBeforeYield))),
  );
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
    // A step that returned its own result still ends its session as completed.
    const settled = await run(
      treeWhen(thread.id, (tree) =>
        tree.attempts.filter((each) => each.taskId !== tree.tasks[0]?.id).every((each) => each.state === "completed"),
      ),
    );
    expect(settled.attempts.filter((each) => each.taskId !== settled.tasks[0]?.id)).toHaveLength(2);

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
    const { run, control } = setUp({ limits: { maxRunningStepsPerHob: 2, maxRunningStepsPerTree: 3 } });
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
    const { run } = setUp({ limits: { maxRunningStepsPerHob: 4, maxRunningStepsPerTree: 1 } });
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
    const { run } = setUp({ before: leftRunning });
    const tree = Option.getOrThrow(await run(TaskRepository.use((tasks) => tasks.readTree(TOP))));
    expect(tree.attempts.map((each) => each.state)).toEqual(["interrupted", "interrupted"]);
    expect(tree.tasks.map((task) => task.state)).toEqual(["active", "failed"]);
  });

  // covers OR-003
  it("[TC-OR-035] a Task whose cancel was asked for is confirmed once its last step stops", async () => {
    const { run } = setUp();
    const thread = await run(seed);
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps: [{ brief: "Slow work" }] })));
    const running = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "active"));
    const [top, step] = running.tasks as [Task, Task];
    // As Cancel on the Quest tab will: the Task and its step move to cancelling together.
    // Each move reads the Task again, since the turn that planned the steps may still be ending.
    const cancel = (id: TaskId) =>
      retry(
        Effect.gen(function* () {
          const tasks = yield* TaskRepository;
          const [task] = Option.getOrThrow(yield* tasks.readTree(id)).tasks;
          yield* tasks.moveTask(id, (task as Task).revision, "cancelling", now);
        }),
      );
    await run(
      Effect.gen(function* () {
        yield* cancel(step.id);
        yield* cancel(top.id);
        yield* TaskSignal.use((signal) => signal.notify);
      }),
    );
    const ended = await run(treeWhen(thread.id, (tree) => tree.tasks[0]?.state === "cancelled"));
    expect(ended.tasks.map((task) => task.state)).toEqual(["cancelled", "cancelled"]);
  });

  // covers OR-001, EX-005
  it("[TC-OR-036] a key from an earlier request is refused in a later one, never replayed", async () => {
    const { run, control } = setUp();
    const thread = await run(seed);
    const plan = hub("plan_steps", { key: "plan", steps: [{ brief: "Draft" }] });
    await run(send(thread.id, `First request\n${plan}`));
    await run(control.open("Draft"));
    await run(treeWhen(thread.id, (tree) => states(tree)[0] === "completed"));
    await run(send(thread.id, hub("complete_task", { key: "done", summary: "First done" })));
    const again = await run(send(thread.id, `Second request\n${plan}`));
    expect(again.content).toContain("Refused (key-reused)");
    const trees = await run(TaskRepository.use((tasks) => tasks.readThreadTrees(thread.id)));
    expect(trees.map((tree) => tree.tasks[0]?.state)).toEqual(["completed"]);
  });

  // covers PE-008
  it("[TC-OR-037] narrowing its hob's folders stops a running step and fails it with the reason", async () => {
    folders = ["/work/site", "/work/brand"];
    const { run } = setUp();
    const thread = await run(seed);
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps: [{ brief: "Edit the site" }] })));
    const running = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "active"));
    const step = stepsOf(running)[0] as Task;

    folders = ["/work/site"];
    await run(ChatService.use((chat) => chat.reviewAuthority(ALDRIC)));
    const failed = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "failed"));
    const attempt = failed.attempts.find((each) => each.taskId === step.id);
    expect(attempt?.state).toBe("interrupted");
    expect(attempt?.outcome).toBe("Stopped because its hob's permissions were narrowed.");
  });

  // covers PE-008
  it("[TC-OR-038] narrowing its hob's folders while a step starts stops that step before it works", async () => {
    folders = ["/work/site", "/work/brand"];
    // Fibers yield every few operations, so the waiting review runs as soon as the start lets go of
    // the authority lock. Before the fix it then found the step with no session to stop.
    const { run, control } = setUp({ opsBeforeYield: 4 });
    const thread = await run(seed);
    await run(send(thread.id, hub("plan_steps", { key: "plan", steps: chain(["Outline", "Edit the site"]) })));
    await run(treeWhen(thread.id, (tree) => states(tree)[0] === "active"));

    // The second step reads its hob's wide access as it starts, and waits there.
    const hold = { reached: await run(Deferred.make<void>()), release: await run(Deferred.make<void>()) };
    held = hold;
    await run(control.open("Outline"));
    await run(Deferred.await(hold.reached));

    // The folders narrow before the step has a session; the review waits for it to be started.
    folders = ["/work/site"];
    const review = run(ChatService.use((chat) => chat.reviewAuthority(ALDRIC)));
    await run(Deferred.succeed(hold.release, undefined));
    await review;

    const failed = await run(treeWhen(thread.id, (tree) => states(tree)[1] === "failed"));
    const step = stepsOf(failed)[1] as Task;
    const attempt = failed.attempts.find((each) => each.taskId === step.id);
    expect(attempt?.state).toBe("interrupted");
    expect(attempt?.outcome).toBe("Stopped because its hob's permissions were narrowed.");
  }, 15_000);
  it("[TC-OR-039] a hob at its open-Task limit cannot start another request's Task from a chat turn", async () => {
    const { run } = setUp({ taskLimits: { ...DEFAULT_TASK_TOOL_LIMITS, maxOpenTasksPerHob: 1 } });
    const first = await run(seed);
    const started = await run(
      send(first.id, `Plan the launch\n${hub("start_quest", { key: "launch", goal: "Launch" })}`),
    );
    expect(started.content).not.toContain("Refused");
    const second = await run(ChatService.use((chat) => chat.createThread(ALDRIC)));
    const refused = await run(send(second.id, `Plan the sale\n${hub("start_quest", { key: "sale", goal: "Sale" })}`));
    expect(refused.content).toContain("Refused (concurrency-limit)");
    // The refused call leaves no Task behind in the second conversation.
    expect(await run(TaskRepository.use((tasks) => tasks.readThreadTrees(second.id)))).toEqual([]);
  });
  // covers IN-006, CH-005
  it("[TC-OR-051] a request whose hob asked you a question completes once the next turn is briefed with your answer", async () => {
    const { run, control } = setUp();
    const thread = await run(seed);
    const steps = [{ brief: `Outline\n${hub("complete_task", { key: "o", summary: "Outlined" })}` }];
    await run(
      send(
        thread.id,
        `Plan the launch\n${hub("plan_steps", { key: "plan", steps })}\n${hub("ask", { key: "q", question: "Which date?" })}`,
      ),
    );
    await run(control.open("Outline"));
    const asked = await run(
      treeWhen(
        thread.id,
        (tree) => tree.questions.length === 1 && states(tree).every((state) => state === "completed"),
      ),
    );
    const question = asked.questions[0];
    if (question === undefined) throw new Error("no question");
    await run(TaskRepository.use((tasks) => tasks.answerQuestion(question.id, { _tag: "User" }, "Friday", now)));

    await run(send(thread.id, hub("complete_task", { key: "done", summary: "Launch on Friday" })));
    expect(control.requests.at(-1)?.briefing).toContain("Which date? Answer: Friday");
    const finished = await run(treeWhen(thread.id, (tree) => tree.tasks[0]?.state === "completed"));
    expect(finished.tasks[0]?.result?.summary).toBe("Launch on Friday");
    const ledger = await run(TaskRepository.use((tasks) => tasks.readLedger(finished.tasks[0]?.id ?? TaskId.make(""))));
    expect(Option.getOrThrow(ledger).open).toEqual([]);
  });

  // covers IN-006, OR-005
  it("[TC-OR-052] a step that was handed an artifact completes from the prompt that showed it, and so does its Task", async () => {
    const { run, control } = setUp();
    const thread = await run(seed);
    const steps = [
      {
        brief: `Draft\n${hub("complete_task", { key: "d", summary: "Drafted", artifacts: [{ kind: "text", label: "Doc", value: "The draft" }] })}`,
      },
      { brief: `Review\n${hub("complete_task", { key: "r", summary: "Reviewed" })}`, after: [1] },
      { brief: `Publish\n${hub("complete_task", { key: "p", summary: "Published" })}`, after: [2] },
    ];
    await run(send(thread.id, `Write the post\n${hub("plan_steps", { key: "plan", steps })}`));
    await run(control.open("Draft"));
    const drafted = await run(treeWhen(thread.id, (tree) => states(tree).join() === "completed,active,queued"));
    const publish = stepsOf(drafted)[2];
    const artifact = drafted.artifacts[0];
    if (publish === undefined || artifact === undefined) throw new Error("no step or artifact");
    // The owner hands the draft to the last step before it starts.
    await run(send(thread.id, hub("hand_off", { key: "h", artifact_id: artifact.id, to_task_id: publish.id })));
    await run(control.open("Review"));
    await run(control.open("Publish"));
    await run(treeWhen(thread.id, (tree) => states(tree).every((state) => state === "completed")));
    const prompt = control.requests.find((request) => request.prompt.startsWith("Publish"))?.prompt ?? "";
    expect(prompt).toContain("Handed to this step:");

    await run(send(thread.id, hub("complete_task", { key: "done", summary: "The post is out" })));
    const finished = await run(treeWhen(thread.id, (tree) => tree.tasks[0]?.state === "completed"));
    expect(finished.tasks[0]?.result?.summary).toBe("The post is out");
  });

  // covers IN-006, EX-006
  it("[TC-OR-053] a step that ends without reaching a milestone it promised fails with a blocker that says so", async () => {
    const { run, control } = setUp();
    const thread = await run(seed);
    const steps = [{ brief: "Research the market", milestones: ["Sources listed"] }];
    await run(send(thread.id, `Research\n${hub("plan_steps", { key: "plan", steps })}`));
    await run(control.open("Research the market"));
    const ended = await run(treeWhen(thread.id, (tree) => states(tree)[0] === "failed"));
    const step = stepsOf(ended)[0];
    const blocker = ended.checkpoints.find((each) => each.taskId === step?.id && each.kind === "blocker");
    expect(blocker?.summary).toContain('milestone "Sources listed" is not reached');
  });
});
