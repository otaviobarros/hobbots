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
  TaskTurns,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  type Message,
  MessageId,
  type Task,
  type TaskTree,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
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
const ROOK = AgentId.make("rook");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("campaign");
/** A prompt with this line of its own waits, before it does anything, until the test lets it go on. */
const HOLD = "fake:hold";
/** A prompt with this line waits like HOLD once its session has started, so a stop can reach it. */
const HOLD_STARTED = "fake:hold-started";
/** A prompt with this line waits like HOLD, and cannot be stopped while it waits. */
const STUCK = "fake:stuck";
/** A prompt with this line fails the first time it is sent, and runs as written after. */
const FLAKY = "fake:flaky";
/** A prompt with this line fails every time it is sent. */
const FAILS = "fake:fails";
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
          const flaky = lines.includes(FAILS) || (lines.includes(FLAKY) && !failedOnce.has(sent.prompt));
          if (flaky) failedOnce.add(sent.prompt);
          const request = flaky ? { ...sent, prompt: `fake:cut-off\n${sent.prompt}` } : sent;
          requests.push(request);
          const stream = fake.sendPrompt(request);
          if (lines.includes(STUCK))
            return Stream.unwrap(Effect.as(Effect.uninterruptible(Deferred.await(gates.stuck)), stream));
          if (lines.includes(HOLD_STARTED)) {
            let started = false;
            return Stream.mapEffect(stream, (event) => {
              const wait = started ? Deferred.await(gates.hold) : Effect.void;
              started = started || event._tag === "SessionStarted";
              return Effect.as(wait, event);
            });
          }
          return lines.includes(HOLD) ? Stream.unwrap(Effect.as(Deferred.await(gates.hold), stream)) : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

const Party = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const party = [hob(ALDRIC, "Aldric"), hob(QUILL, "Quill"), hob(ADA, "Ada"), hob(ROOK, "Rook"), hob(PIP, "Pip")];
    for (const each of party) yield* repo.insertAgent(each);
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
        Layer.succeed(UserSession, {
          deviceId: WINDOW_DEVICE_ID,
          name: "This computer's Hobbots window",
          kind: "window",
          whileApproved: (write) => write,
        }),
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

const isTerminal = (state: string) => state === "completed" || state === "cancelled" || state === "failed";

const attemptsOf = (tree: TaskTree, task: Task | undefined) =>
  tree.attempts.filter((each) => each.taskId === task?.id).map((each) => [each.agentId, each.state]);

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

const controls = <A, E>(use: (each: TaskControls["Service"]) => Effect.Effect<A, E, UserSession>) =>
  TaskControls.use(use);

/** Aldric brings in Quill, whose turn is held, and Ada, whose Task stays queued on Quill's with no turn running. */
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

/** Ada's Task queued, Quill's turn live, and Aldric's own turn ended, so his Task waits (#572). */
const underWay = (tree: TaskTree) =>
  ownedBy(tree, ADA)?.state === "queued" &&
  tree.attempts.some((each) => each.agentId === QUILL && isLive(each.state)) &&
  tree.tasks[0]?.state === "waiting";

/** Aldric brings in Rook, who brings in Pip under his own Quest; Pip's turn is held while Rook waits on her. */
const nestedUnderWay = [
  "Plan the Black Friday campaign",
  hub("delegate_task", {
    key: "ads",
    hob: "Rook",
    brief: [
      "Run the ads",
      hub("delegate_task", {
        key: "keywords",
        hob: "Pip",
        brief: [
          "Research the keywords",
          HOLD,
          hub("complete_task", { key: "keywords-done", summary: "Keywords" }),
        ].join("\n"),
      }),
      hub("wait_for", { key: "rook-wait", tasks: ["$keywords.task_id"] }),
    ].join("\n"),
  }),
  hub("wait_for", { key: "wait", tasks: ["$ads.task_id"] }),
].join("\n");

const nestedRunning = (tree: TaskTree) =>
  ownedBy(tree, ROOK)?.state === "waiting" &&
  tree.attempts.some((each) => each.agentId === PIP && isLive(each.state)) &&
  !tree.attempts.some((each) => each.agentId === ROOK && isLive(each.state));

/** Your request in the thread, its step done and every reply ended: the Task the next message works on. */
const requestDone = Effect.gen(function* () {
  const first = ["Write the copy", hub("plan_steps", { key: "plan", steps: [{ brief: "Draft the headlines" }] })].join(
    "\n",
  );
  yield* ChatService.use((chat) => chat.sendPrompt(threadId, first));
  const tree = yield* treeWhen(
    (each) => each.tasks[1]?.state === "completed" && !each.attempts.some((attempt) => isLive(attempt.state)),
  );
  yield* Effect.sleep("300 millis");
  yield* messagesWhen(() => true);
  const top = tree.tasks[0];
  return top === undefined ? yield* Effect.die("no Task") : top;
});

/** A turn briefed on the open Task that ended its Attempt but holds on to its tools. */
const strayTurn = Effect.gen(function* () {
  const [opening] = yield* messages();
  const turn = yield* TaskTurns.use((turns) =>
    turns.forChat({
      agentId: ALDRIC,
      threadId,
      messageId: MessageId.make(opening?.id ?? "none"),
      prompt: "Keep going",
      runtime: "claude-code",
      configVersion: 1,
    }),
  );
  yield* turn.end({ _tag: "Replied", text: "" }, null, null);
  return turn;
});

/** Your next message in the thread, held by `gate` once its turn has started. */
const laterReply = (gate: string, requests: ReadonlyArray<PromptRequest>) =>
  Effect.gen(function* () {
    const second = ["Now the emails", gate, hub("plan_steps", { key: "more", steps: [{ brief: "Draft the emails" }] })];
    yield* ChatService.use((chat) => chat.sendPrompt(threadId, second.join("\n")));
    yield* retry(
      Effect.suspend(() =>
        requests.some((each) => each.prompt.includes("Now the emails")) ? Effect.void : Effect.fail("not yet" as const),
      ),
    );
    // Its Attempt is recorded before its session starts.
    yield* treeWhen((tree) => tree.attempts.some((each) => each.taskId === tree.tasks[0]?.id && isLive(each.state)));
  });

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
    // Ada's Task never started: it was still waiting on Quill's.
    expect(attemptsOf(done, ownedBy(done, ADA))).toEqual([]);
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
  // covers OR-006, OR-004
  it("[TC-OR-164] cancelling the Quest reaches every level of a nested one, each Task confirmed, and starts nothing after", async () => {
    const { run, requests } = setUp();
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, nestedUnderWay)));
    const before = await run(treeWhen(nestedRunning));
    const quest = before.quests.find((each) => each.depth === 1);
    if (quest === undefined) throw new Error("no Quest");

    await run(controls((each) => each.cancelQuest(quest.id)));
    const done = await run(treeWhen((tree) => tree.tasks.every((task) => task.state === "cancelled")));
    expect(done.tasks.map((task) => task.ownerId)).toEqual([ALDRIC, ROOK, PIP]);
    expect(done.quests.map((each) => [each.leadId, each.state])).toEqual([
      [ALDRIC, "cancelled"],
      [ROOK, "cancelled"],
    ]);
    // Pip's turn was stopped and confirmed; Rook's had ended while he waited on her.
    expect(attemptsOf(done, ownedBy(done, PIP))).toEqual([[PIP, "cancelled"]]);
    expect(attemptsOf(done, ownedBy(done, ROOK))).toEqual([[ROOK, "completed"]]);
    expect(done.attempts.some((each) => isLive(each.state))).toBe(false);

    const sent = requests.length;
    await run(Effect.sleep("200 millis"));
    expect(requests).toHaveLength(sent);
    expect(continuations(await run(messages()))).toEqual([]);
  }, 20_000);

  // covers OR-006, OR-004
  it("[TC-OR-165] cancelling Rook's Task cancels Pip's under it and leaves Aldric's Quest going; neither changes hands across levels", async () => {
    const { run } = setUp();
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, nestedUnderWay)));
    const before = await run(treeWhen(nestedRunning));
    const rook = ownedBy(before, ROOK);
    const pip = ownedBy(before, PIP);
    if (rook === undefined || pip === undefined) throw new Error("no Tasks");

    // Rook's Task leads a Quest of its own, and Pip cannot take on work above her.
    const refused = (taskId: Task["id"], agentId: AgentId) =>
      run(controls((each) => each.reassign(taskId, agentId)).pipe(Effect.flip));
    expect(await refused(rook.id, QUILL)).toMatchObject({ _tag: "TaskNotControllable", reason: "children-open" });
    expect(await refused(pip.id, ALDRIC)).toMatchObject({ reason: "lineage-owner" });

    await run(controls((each) => each.cancel(rook.id)));
    const cancelled = await run(
      treeWhen((tree) => [ROOK, PIP].every((agentId) => ownedBy(tree, agentId)?.state === "cancelled")),
    );
    expect(attemptsOf(cancelled, ownedBy(cancelled, PIP))).toEqual([[PIP, "cancelled"]]);
    expect(cancelled.quests.map((each) => [each.leadId, each.state])).toEqual([
      [ALDRIC, "active"],
      [ROOK, "cancelled"],
    ]);
    expect(cancelled.tasks[0]?.state).toBe("waiting");
    // Aldric hears that Rook's Task ended; Pip's is Rook's to hear about, not his.
    const all = await run(
      messagesWhen((each) => continuations(each).some((reply) => reply.content.includes("ended as cancelled."))),
    );
    const told = continuations(all)
      .map((reply) => reply.content)
      .join("\n");
    expect(told).toContain(`Task ${rook.id}`);
    expect(told).not.toContain(`Task ${pip.id} ended`);
  }, 20_000);

  // covers OR-006
  it("[TC-OR-150] cancelling the Task you asked for waits for a later reply working on it to stop, and starts nothing in its place", async () => {
    const { run, release, requests } = setUp();
    const top = await run(requestDone);
    // A turn briefed on the Task before the cancel, which goes on calling after its Attempt ended.
    const stray = await run(strayTurn);

    // Your next message there works on the same Task, in the same Attempt.
    await run(laterReply(HOLD_STARTED, requests));
    await run(controls((each) => each.cancel(top.id)));
    // The reply's stop may land at once or once it goes on; either way the cancel waits for it.
    await release();
    const all = await run(messagesWhen(() => true));
    expect(all.at(-1)?.status).toBe("stopped");
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "cancelled"));
    // Your request's turn, the reply its step's result started, the stray turn and yours all worked
    // in the Task's one Attempt, which ended cancelled when yours was stopped by the cancel (#669).
    expect(attemptsOf(done, done.tasks[0])).toEqual([[ALDRIC, "cancelled"]]);
    // Confirmed only once the reply's Attempt had ended.
    const reply = done.attempts.filter((each) => each.taskId === top.id).at(-1);
    expect(reply?.endedAt).not.toBeNull();
    expect(Date.parse(done.tasks[0]?.updatedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(reply?.endedAt ?? ""));

    const answer = await run(stray.hubTools.call("plan_steps", { key: "stray", steps: [{ brief: "Draft the ads" }] }));
    expect(answer).toMatchObject({ refused: true });
    expect(answer.text).toContain("task-cancelling");
    await run(Effect.sleep("300 millis"));
    const trees = await run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    expect(trees).toHaveLength(1);
    expect(trees[0]?.tasks.map((task) => task.state)).toEqual(["cancelled", "completed"]);
  }, 20_000);

  // covers OR-006, EX-003
  it("[TC-OR-154] a later reply that does not stop in time leaves the cancel of the Task you asked for unresolved", async () => {
    const { run, unstick, requests } = setUp();
    const top = await run(requestDone);
    await run(laterReply(STUCK, requests));
    await run(controls((each) => each.cancel(top.id)));
    expect((await run(treeWhen(() => true))).tasks[0]?.state).toBe("cancelling");

    // The reply is still stopping when the cancel's time runs out.
    const ended = await run(treeWhen((tree) => tree.tasks[0]?.state === "cancelled"));
    const stop = ended.attempts.filter((each) => each.taskId === top.id).at(-1);
    expect(stop).toMatchObject({ state: "unresolved" });
    expect(stop?.outcome).toContain("could not confirm");
    expect((await run(messages())).at(-1)?.status).toBe("stopping");

    // When it lets go at last, the outcome on record stays as it is.
    await unstick();
    await run(messagesWhen(() => true));
    await run(Effect.sleep("300 millis"));
    const after = await run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId)));
    expect(after).toHaveLength(1);
    expect(after[0]?.tasks[0]?.state).toBe("cancelled");
    expect(after[0]?.attempts.find((each) => each.id === stop?.id)?.state).toBe("unresolved");
  }, 20_000);
  // covers OR-006, IN-003
  it("[TC-OR-180] cancelling the Quest while its lead reads a member's result leaves nothing waiting in any backpack", async () => {
    const { run, release, requests } = setUp();
    // Rook's result holds Aldric's continuation once its session has started, so the cancel stops it.
    const prompt = [
      "Plan the Black Friday campaign",
      hub("delegate_task", {
        key: "ads",
        hob: "Rook",
        brief: [
          "Run the ads",
          hub("complete_task", { key: "ads-done", summary: ["Ads ready", HOLD_STARTED, "That is all"].join("\n") }),
        ].join("\n"),
      }),
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: ["Draft the landing copy", HOLD, hub("complete_task", { key: "copy-done", summary: "Copy" })].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$ads.task_id", "$copy.task_id"] }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    const before = await run(treeWhen((tree) => ownedBy(tree, ROOK)?.state === "completed"));
    const quest = before.quests[0];
    if (quest === undefined) throw new Error("no Quest");
    // Aldric's continuation reads Rook's result, its items held under the turn's claims.
    await run(
      retry(
        Effect.gen(function* () {
          const reading = continuations(yield* messages()).some((reply) => reply.status === "streaming");
          const open = yield* Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: ALDRIC }));
          return reading && open.some((item) => item.state === "processing")
            ? undefined
            : yield* Effect.fail("not yet");
        }),
      ),
    );
    expect(requests.some((each) => each.prompt.split("\n").includes(HOLD_STARTED))).toBe(true);

    await run(controls((each) => each.cancelQuest(quest.id)));
    const done = await run(
      treeWhen((tree) => tree.tasks.every((task) => ["cancelled", "completed"].includes(task.state))),
    );
    expect(done.tasks.map((task) => [task.ownerId, task.state])).toEqual([
      [ALDRIC, "cancelled"],
      [ROOK, "completed"],
      [QUILL, "cancelled"],
    ]);
    expect(done.quests[0]?.state).toBe("cancelled");

    // What the stopped turn carried, and what the cancel sent Aldric about Quill, resolve as late
    // without waiting for another turn of his.
    const open = await run(
      retry(
        Effect.flatMap(
          Backpack.use((backpack) => backpack.listOpen({ _tag: "Workspace" })),
          (items) => (items.length === 0 ? Effect.succeed(items) : Effect.fail("not yet" as const)),
        ),
      ).pipe(Effect.catch(() => Backpack.use((backpack) => backpack.listOpen({ _tag: "Workspace" })))),
    );
    expect(open.map((item) => [item.recipientId, item.kind, item.state])).toEqual([]);
    const all = await run(messagesWhen(() => true));
    expect(continuations(all).map((reply) => reply.status)).toEqual(["stopped"]);
    // Nothing starts after: no continuation for the late work.
    const sent = requests.length;
    await release();
    await run(Effect.sleep("300 millis"));
    expect(requests).toHaveLength(sent);
  }, 20_000);
  // covers OR-006, IN-005
  it("[TC-OR-184] cancelling the Quest resolves the routine progress its party reported, with no turn to carry it", async () => {
    const { run, release, requests } = setUp();
    // Rook's step reports progress and finishes; its result holds Rook's continuation once started.
    // The progress waits for Aldric, whose Task waits on Rook with no turn running.
    const prompt = [
      "Plan the Black Friday campaign",
      hub("delegate_task", {
        key: "ads",
        hob: "Rook",
        brief: [
          "Run the ads",
          hub("plan_steps", {
            key: "plan",
            steps: [
              {
                brief: [
                  "Pick the channels",
                  hub("report_checkpoint", { key: "draft", kind: "progress", summary: "Channels shortlisted" }),
                  hub("complete_task", {
                    key: "picked",
                    summary: ["Channels", HOLD_STARTED, "That is all"].join("\n"),
                  }),
                ].join("\n"),
              },
            ],
          }),
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$ads.task_id"] }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    const openFor = (agentId: AgentId) => Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId }));
    await run(
      retry(
        Effect.gen(function* () {
          const reading = (yield* openFor(ROOK)).some((item) => item.kind === "result" && item.state === "processing");
          const progress = (yield* openFor(ALDRIC)).some(
            (item) => item.kind === "progress" && item.state === "pending",
          );
          return reading && progress ? undefined : yield* Effect.fail("not yet" as const);
        }),
      ),
    );
    const quest = (await run(treeWhen(() => true))).quests[0];
    if (quest === undefined) throw new Error("no Quest");

    await run(controls((each) => each.cancelQuest(quest.id)));
    await run(treeWhen((tree) => tree.tasks.every((task) => isTerminal(task.state))));
    const workspace = Backpack.use((backpack) => backpack.listOpen({ _tag: "Workspace" }));
    const open = await run(
      retry(
        Effect.flatMap(workspace, (items) => (items.length === 0 ? Effect.succeed(items) : Effect.fail("not yet"))),
      ).pipe(Effect.catch(() => workspace)),
    );
    expect(open.map((item) => [item.recipientId, item.kind, item.state])).toEqual([]);
    // Nothing starts after for the late work.
    const sent = requests.length;
    await release();
    await run(Effect.sleep("300 millis"));
    expect(requests).toHaveLength(sent);
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
    // A step completes before its Attempt ends, so both are waited for.
    const done = await run(
      treeWhen((tree) => tree.tasks[1]?.state === "completed" && !tree.attempts.some((each) => isLive(each.state))),
    );
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
    const done = await run(
      treeWhen(
        (tree) =>
          tree.tasks.find((task) => task.id === copy.id)?.state === "completed" &&
          !tree.attempts.some((each) => isLive(each.state)),
      ),
    );
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

  // covers OR-006, EX-001
  it("[TC-OR-151] a Task given back to a hob it had before starts afresh there, not in its old session", async () => {
    const { run, requests } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Draft the copy", FAILS].join("\n") }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    /** The Task's Attempts once `count` of them have ended. */
    const ended = (count: number) =>
      run(
        treeWhen((tree) => {
          const copy = tree.tasks[1];
          const attempts = tree.attempts.filter((each) => each.taskId === copy?.id);
          return attempts.length === count && !attempts.some((each) => isLive(each.state));
        }),
      );
    const once = await ended(1);
    const copy = once.tasks[1];
    if (copy === undefined) throw new Error("no Task for Quill");
    expect(once.attempts[0]?.sessionId).not.toBeNull();

    await run(controls((each) => each.reassign(copy.id, ADA)));
    await ended(2);
    await run(controls((each) => each.reassign(copy.id, QUILL)));
    const back = await ended(3);

    const attempts = back.attempts.filter((each) => each.taskId === copy.id);
    expect(attempts.map((each) => each.agentId)).toEqual([QUILL, ADA, QUILL]);
    expect(attempts[2]?.sessionId).not.toBe(attempts[0]?.sessionId);
    // Each owner starts from the lead's brief in a session of its own, Quill the second time too.
    const fresh = requests.filter(
      (each) => each.prompt.includes("Draft the copy") && !each.prompt.includes("delegate_task"),
    );
    expect(fresh.map((each) => each.sessionId)).toEqual([null, null, null]);
  }, 20_000);
});
