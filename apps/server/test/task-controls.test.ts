import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  TaskControls,
  TaskRepository,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  type Message,
  type Task,
  type TaskTree,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack, Dispatcher } from "@hobbots/inbox";
import { DEFAULT_STEP_LIMITS, StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
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
import { Deferred, Effect, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #276: Cancel, Retry and Reassign act on a Task directly and report what really happened
// (OR-006). The fake runtime scripts every hob's calls; the controls are called as the user would
// from the Quest tab.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-controls-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
mkdirSync(project, { recursive: true });

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const threadId = ThreadId.make("campaign");
/** A prompt with this line of its own waits, before it does anything, until the test lets it go on. */
const HOLD = "fake:hold";
/** A prompt with this line waits like HOLD, and cannot be stopped while it waits. */
const STUCK = "fake:stuck";
/** A prompt with this line fails the first time it is sent, and runs as written after. */
const FLAKY = "fake:flaky";
const CANCEL_TIMEOUT_MS = 300;

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Marketing",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

const ProjectTools = Layer.succeed(
  HobTools,
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [project],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(temp, "data"),
          restrictions: [],
        },
        folders: [project],
        runtimeFolder: join(temp, "runtime", agent.id),
      }),
  }),
);

interface Gates {
  readonly hold: Deferred.Deferred<void>;
  readonly stuck: Deferred.Deferred<void>;
}

const scripted = (gates: Gates, requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      const failedOnce = new Set<string>();
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (sent) => {
          const lines = sent.prompt.split("\n");
          const flaky = lines.includes(FLAKY) && !failedOnce.has(sent.prompt);
          if (flaky) failedOnce.add(sent.prompt);
          const request = flaky ? { ...sent, prompt: `fake:cut-off\n${sent.prompt}` } : sent;
          requests.push(request);
          const stream = fake.sendPrompt(request);
          if (lines.includes(STUCK))
            return Stream.unwrap(Effect.as(Effect.uninterruptible(Deferred.await(gates.stuck)), stream));
          return lines.includes(HOLD) ? Stream.unwrap(Effect.as(Deferred.await(gates.hold), stream)) : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

const Party = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const each of [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill"), hob(ADA, "Ada")]) yield* repo.insertAgent(each);
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: ALDRIC, title: "Black Friday", createdAt: now, updatedAt: now }),
    );
  }),
);

const makeApp = (gates: Gates, requests: Array<PromptRequest>) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer, TaskControls.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(ContinuationsLive),
    Layer.provideMerge(
      StepRunnerLive({ ...DEFAULT_STEP_LIMITS, cancelTimeoutMs: CANCEL_TIMEOUT_MS }).pipe(
        Layer.provideMerge(MemberContinuationsLive),
        Layer.provideMerge(TaskTools.layer("/")),
        Layer.provideMerge(TaskSignal.layer),
      ),
    ),
    Layer.provideMerge(Dispatcher.layer().pipe(Layer.provideMerge(DispatcherHostLive))),
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
        ProjectTools,
        HobAdmission.layer,
        scripted(gates, requests),
        Layer.succeed(UserSession, { origin: "http://localhost:4317" }),
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
  const gates = { hold: Deferred.makeUnsafe<void>(), stuck: Deferred.makeUnsafe<void>() };
  const app = ManagedRuntime.make(makeApp(gates, requests));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  return {
    run,
    requests,
    release: () => run(Deferred.succeed(gates.hold, undefined)),
    unstick: () => run(Deferred.succeed(gates.stuck, undefined)),
  };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 800 }));

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

const messages = () => HobbotsRepository.use((repo) => repo.listMessages(threadId));

/** The thread's messages once `ready` holds for them, every reply ended. */
const messagesWhen = (ready: (all: ReadonlyArray<Message>) => boolean) =>
  retry(
    Effect.gen(function* () {
      const all = yield* messages();
      const ended = all.every((m) => m.status !== "streaming" && m.status !== "stopping");
      return ended && ready(all) ? all : yield* Effect.fail("not yet" as const);
    }),
  );

/** The request's whole tree once `ready` holds for it. */
const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      return tree !== undefined && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

const ownedBy = (tree: TaskTree, agentId: AgentId): Task | undefined =>
  tree.tasks.find((task) => task.ownerId === agentId && task.parentId !== null);

const isLive = (state: string) => state === "starting" || state === "running";

const attemptsOf = (tree: TaskTree, task: Task | undefined) =>
  tree.attempts.filter((each) => each.taskId === task?.id).map((each) => [each.agentId, each.state]);

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

const controls = <A, E>(use: (each: TaskControls["Service"]) => Effect.Effect<A, E, UserSession>) =>
  TaskControls.use(use);

/** Aldric brings in Quill, whose turn is held, and Ada, who waits on Quill's copy with no turn running. */
const questUnderWay = (quillBrief: ReadonlyArray<string> = [HOLD]) =>
  [
    "Plan the Black Friday campaign",
    hub("delegate_task", {
      key: "copy",
      hob: "Quill",
      brief: [
        "Draft the landing copy",
        ...quillBrief,
        hub("complete_task", { key: "copy-done", summary: "Copy" }),
      ].join("\n"),
    }),
    hub("delegate_task", {
      key: "build",
      hob: "Ada",
      brief: "Build the campaign once the copy exists",
      depends_on: ["$copy.task_id"],
    }),
    hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$build.task_id"] }),
  ].join("\n");

const underWay = (tree: TaskTree) =>
  ownedBy(tree, ADA)?.state === "waiting" && tree.attempts.some((each) => each.agentId === QUILL && isLive(each.state));

describe("cancelling with confirmed outcomes", () => {
  // covers OR-006
  it("[TC-OR-143] cancelling the Quest shows it cancelling until every Task confirms, and starts nothing after", async () => {
    const { run, requests } = setUp();
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, questUnderWay())));
    const before = await run(treeWhen(underWay));
    await run(messagesWhen((all) => all.length === 2));
    const quest = before.quests[0];
    if (quest === undefined) throw new Error("no Quest");

    await run(controls((each) => each.cancelQuest(quest.id)));
    // Recorded at once: Quill's turn still has to stop, so the Task you asked for shows cancelling.
    const asked = await run(TaskRepository.use((tasks) => tasks.readTree(quest.taskId)));
    expect(asked._tag === "Some" && asked.value.tasks[0]?.state).toBe("cancelling");

    const done = await run(treeWhen((tree) => tree.tasks.every((task) => task.state === "cancelled")));
    expect(done.quests[0]?.state).toBe("cancelled");
    expect(attemptsOf(done, ownedBy(done, QUILL))).toEqual([[QUILL, "cancelled"]]);
    expect(attemptsOf(done, ownedBy(done, ADA))).toEqual([[ADA, "completed"]]);
    expect(done.attempts.some((each) => isLive(each.state))).toBe(false);

    // What the cancel sent Aldric about his party resolves as late, so it wakes nobody.
    const sent = requests.length;
    await run(
      retry(
        Effect.flatMap(
          Backpack.use((backpack) => backpack.listOpen({ _tag: "Workspace" })),
          (items) => (items.length === 0 ? Effect.void : Effect.fail("not yet" as const)),
        ),
      ),
    );
    await run(Effect.sleep("200 millis"));
    expect(requests).toHaveLength(sent);
    expect(continuations(await run(messages()))).toEqual([]);
    // Cancelling again changes nothing.
    await run(controls((each) => each.cancelQuest(quest.id)));
    expect((await run(treeWhen(() => true))).tasks.map((task) => task.revision)).toEqual(
      done.tasks.map((task) => task.revision),
    );
  }, 20_000);

  // covers OR-006
  it("[TC-OR-144] cancelling a member's Task that waits with no turn running confirms it, and its lead hears of it", async () => {
    const { run, release } = setUp();
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, questUnderWay())));
    const before = await run(treeWhen(underWay));
    const ada = ownedBy(before, ADA);
    if (ada === undefined) throw new Error("no Task for Ada");

    await run(controls((each) => each.cancel(ada.id)));
    const cancelled = await run(treeWhen((tree) => ownedBy(tree, ADA)?.state === "cancelled"));
    expect(cancelled.tasks[0]?.state).toBe("waiting");
    expect(ownedBy(cancelled, QUILL)?.state).toBe("active");
    await run(messagesWhen((all) => continuations(all).some((reply) => reply.content.includes("ended as cancelled."))));

    // Quill goes on and finishes; the Quest is still Aldric's to wrap up.
    await release();
    const done = await run(treeWhen((tree) => ownedBy(tree, QUILL)?.state === "completed"));
    expect(done.quests[0]?.state).toBe("active");
  }, 20_000);

  // covers OR-006, EX-003
  it("[TC-OR-145] a session that does not stop in time leaves its cancel unresolved, and the Quest still ends", async () => {
    const { run, unstick } = setUp();
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, questUnderWay([STUCK]))));
    const before = await run(treeWhen(underWay));
    const quest = before.quests[0];
    if (quest === undefined) throw new Error("no Quest");

    await run(controls((each) => each.cancelQuest(quest.id)));
    const ended = await run(treeWhen((tree) => tree.tasks[0]?.state === "cancelled"));
    const quill = ownedBy(ended, QUILL);
    expect(quill?.state).toBe("cancelled");
    const [stop] = ended.attempts.filter((each) => each.taskId === quill?.id);
    expect(stop?.state).toBe("unresolved");
    expect(stop?.outcome).toContain("could not confirm");
    expect(ended.quests[0]?.state).toBe("cancelled");

    // When the session finally lets go, nothing it reports changes the outcome on record.
    await unstick();
    await run(Effect.sleep("300 millis"));
    const after = await run(treeWhen(() => true));
    expect(ownedBy(after, QUILL)).toMatchObject({ state: "cancelled", result: null });
    expect(after.attempts.find((each) => each.id === stop?.id)?.state).toBe("unresolved");
  }, 20_000);

  // covers OR-006, IN-003
  it("[TC-OR-146] a late result from a cancelled Task changes nothing", async () => {
    const { run, release } = setUp();
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, questUnderWay())));
    const before = await run(treeWhen(underWay));
    const quill = ownedBy(before, QUILL);
    if (quill === undefined) throw new Error("no Task for Quill");
    await run(controls((each) => each.cancel(quill.id)));
    const cancelled = await run(treeWhen((tree) => ownedBy(tree, QUILL)?.state === "cancelled"));

    // Quill's result arrives after the cancel, as his tool call would: it is refused.
    const late = await run(
      TaskTools.use((tools) =>
        tools.call({ agentId: QUILL, taskId: quill.id }, "complete_task", { key: "late", summary: "Copy, at last" }),
      ).pipe(Effect.flip),
    );
    expect(late).toMatchObject({ _tag: "TaskToolRefused", reason: "task-state" });
    await release();
    await run(Effect.sleep("200 millis"));
    const after = await run(treeWhen(() => true));
    expect(ownedBy(after, QUILL)).toMatchObject({ state: "cancelled", result: null });
    expect(after.artifacts).toEqual([]);
    expect(ownedBy(after, QUILL)?.revision).toBe(ownedBy(cancelled, QUILL)?.revision);
  }, 20_000);
});

describe("retrying and reassigning", () => {
  // covers EX-001, OR-006
  it("[TC-OR-147] retrying a failed step runs it again as a new Attempt of the same Task", async () => {
    const { run } = setUp();
    const prompt = [
      "Write the copy",
      hub("plan_steps", { key: "plan", steps: [{ brief: ["Draft the headlines", FLAKY].join("\n") }] }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    const failed = await run(treeWhen((tree) => tree.tasks[1]?.state === "failed"));
    const step = failed.tasks[1];
    if (step === undefined) throw new Error("no step");

    await run(controls((each) => each.retry(step.id)));
    const done = await run(treeWhen((tree) => tree.tasks[1]?.state === "completed"));
    expect(done.tasks[1]?.id).toBe(step.id);
    expect(done.attempts.filter((each) => each.taskId === step.id).map((each) => [each.number, each.state])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    // A Task that has not failed is not retried.
    const again = await run(controls((each) => each.retry(step.id)).pipe(Effect.flip));
    expect(again).toMatchObject({ _tag: "TaskNotControllable", reason: "task-state" });
  }, 20_000);

  // covers OR-006, EX-001
  it("[TC-OR-148] a retired member's failed Task goes to another hob, which finishes it with the history kept", async () => {
    const { run, release, requests } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: ["Draft the copy", HOLD, hub("complete_task", { key: "copy-done", summary: "Copy ready" })].join("\n"),
      }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    await run(treeWhen((tree) => tree.attempts.some((each) => each.agentId === QUILL)));
    await run(HobLifecycle.use((lifecycle) => lifecycle.retire(QUILL, "stop")));
    const failed = await run(treeWhen((tree) => ownedBy(tree, QUILL)?.state === "failed"));
    const copy = ownedBy(failed, QUILL);
    if (copy === undefined) throw new Error("no Task for Quill");

    // Quill is retired, so nobody can retry it as his.
    const retried = await run(controls((each) => each.retry(copy.id)).pipe(Effect.flip));
    expect(retried).toMatchObject({ _tag: "HobUnavailable", agentId: QUILL, status: "retired" });

    await release();
    await run(controls((each) => each.reassign(copy.id, ADA)));
    const done = await run(treeWhen((tree) => tree.tasks.find((task) => task.id === copy.id)?.state === "completed"));
    const moved = done.tasks.find((task) => task.id === copy.id);
    expect(moved).toMatchObject({ ownerId: ADA, result: { summary: "Copy ready" } });
    expect(attemptsOf(done, moved)).toEqual([
      [QUILL, "interrupted"],
      [ADA, "completed"],
    ]);
    expect(done.delegations.map((each) => each.memberId)).toEqual([ADA]);
    expect(done.checkpoints.some((each) => each.taskId === copy.id && each.summary.includes("retired"))).toBe(true);
    // Ada starts afresh from the lead's brief, in a session of her own.
    const adaFirst = requests.find(
      (request) => request.prompt.includes("Draft the copy") && request.sessionId === null,
    );
    expect(adaFirst).toBeDefined();
    expect(await run(TaskRepository.use((tasks) => tasks.listMemberWork(ADA)))).toMatchObject([
      { task: { id: copy.id } },
    ]);
  }, 20_000);

  // covers OR-006
  it("[TC-OR-149] a reassignment is refused while its turn runs, to a hob above it, for the Task you asked for and to a retired hob", async () => {
    const { run } = setUp();
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, questUnderWay())));
    const tree = await run(treeWhen(underWay));
    const quill = ownedBy(tree, QUILL);
    const top = tree.tasks[0];
    if (quill === undefined || top === undefined) throw new Error("no Tasks");

    const refused = (taskId: Task["id"], agentId: AgentId) =>
      run(controls((each) => each.reassign(taskId, agentId)).pipe(Effect.flip));
    expect(await refused(quill.id, ADA)).toMatchObject({ _tag: "TaskNotControllable", reason: "attempt-live" });
    expect(await refused(quill.id, ALDRIC)).toMatchObject({ reason: "lineage-owner" });
    expect(await refused(top.id, QUILL)).toMatchObject({ reason: "not-delegated" });
    await run(HobLifecycle.use((lifecycle) => lifecycle.retire(ADA, "stop")));
    expect(await refused(quill.id, ADA)).toMatchObject({ _tag: "HobUnavailable", agentId: ADA });
    expect(ownedBy(await run(treeWhen(() => true)), QUILL)?.ownerId).toBe(QUILL);
  }, 20_000);
});
