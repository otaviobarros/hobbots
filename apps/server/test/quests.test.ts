import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalRepository,
  ApprovalService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  QuestionService,
  RuntimeAdapter,
  TaskRepository,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type ApprovalRequest,
  EMPTY_HOB_POLICY,
  type Message,
  NoteId,
  type Task,
  type TaskTree,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack, Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
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
import { Deferred, Effect, Layer, ManagedRuntime, Option, Schedule, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #273: a lead brings in a party, each member works in its own session under its own policy
// narrowed by the delegation, results move between members only through the lead, and the lead
// wraps up in your chat. The fake runtime scripts every hob's calls; nobody prompts after the first
// message.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-quests-")));
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

/** Every hob works in the project folder under the Balanced preset: edits run, pushes ask. */
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

const held = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          const stream = fake.sendPrompt(request);
          return request.prompt.split("\n").includes(HOLD)
            ? Stream.unwrap(Effect.as(Deferred.await(gate), stream))
            : stream;
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

const makeApp = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(ContinuationsLive),
    Layer.provideMerge(
      StepRunnerLive().pipe(
        Layer.provideMerge(MemberContinuationsLive),
        Layer.provideMerge(TaskTools.layer("/")),
        Layer.provideMerge(TaskSignal.layer),
      ),
    ),
    Layer.provideMerge(Dispatcher.layer().pipe(Layer.provideMerge(DispatcherHostLive))),
    Layer.provideMerge(Layer.mergeAll(ApprovalService.layer, QuestionService.layer)),
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
        held(gate, requests),
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
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  return { run, requests, release: () => run(Deferred.succeed(gate, undefined)) };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 800 }));

const isLive = (state: string) => state === "starting" || state === "running";

/** The states of a hob's Attempts in the tree, oldest first. */
const attemptStates = (tree: TaskTree, agentId: AgentId) =>
  tree.attempts.filter((each) => each.agentId === agentId).map((each) => each.state);

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

/** The prompts a hob's sessions were sent: its brief, then what arrived for it. */
const promptsTo = (requests: ReadonlyArray<PromptRequest>, task: Task | undefined) =>
  task === undefined
    ? []
    : requests.filter(
        (request) =>
          request.prompt.endsWith(`Task id: ${task.id}.`) ||
          (request.prompt.split("\n\n").at(-1) ?? "").startsWith(`You work on Task ${task.id} `),
      );

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

/** Both members started side by side: Ada's first turn ended while Quill's was still held open. */
const expectBothStarted = (waiting: TaskTree, requests: ReadonlyArray<PromptRequest>) => {
  const quillTask = ownedBy(waiting, QUILL);
  const adaTask = ownedBy(waiting, ADA);
  expect(attemptStates(waiting, QUILL).filter(isLive)).not.toEqual([]);
  expect(attemptStates(waiting, ADA)).toContain("completed");
  expect(adaTask?.dependsOn).toEqual([quillTask?.id]);
  expect(waiting.tasks[0]?.state).toBe("waiting");
  expect(waiting.delegations.map((each) => each.memberId).sort()).toEqual([ADA, QUILL].sort());
  const [adaFirst] = promptsTo(requests, adaTask);
  expect(adaFirst?.sessionId).toBeNull();
  expect(adaFirst?.prompt).toContain("Aldric gave you this Task as part of a Quest Aldric leads.");
  expect(adaFirst?.prompt).toContain(`Task ${quillTask?.id}, active: Draft the landing copy`);
  expect(adaFirst?.prompt).not.toContain("20% off everything");
  const [quillFirst] = promptsTo(requests, quillTask);
  expect(quillFirst?.prompt).toContain("Aldric expects back: Three headlines and a short body");
  return { quillTask, adaTask };
};

/** Ada's second turn got Quill's copy from Aldric and went on in the same session. */
const expectAdaResumed = (done: TaskTree, requests: ReadonlyArray<PromptRequest>, adaTask: Task | undefined) => {
  const adaPrompts = promptsTo(requests, adaTask);
  expect(adaPrompts).toHaveLength(2);
  expect(adaPrompts[1]?.prompt).toContain('"Landing copy" was handed to Task');
  expect(adaPrompts[1]?.prompt).toContain("Black Friday: 20% off everything");
  const adaAttempts = done.attempts.filter((each) => each.taskId === adaTask?.id);
  expect(adaAttempts.map((each) => each.state)).toEqual(["completed", "completed"]);
  expect(adaPrompts[1]?.sessionId).toBe(adaAttempts[0]?.sessionId);
};

describe("leading a party on a Quest", () => {
  // covers OR-002, OR-003, IN-004
  it("[TC-OR-090] Aldric delegates to Quill and Ada in parallel; Ada waits on Quill's copy and gets it through Aldric, who wraps up in the chat", async () => {
    const { run, requests, release } = setUp();
    const prompt = [
      "Plan the Black Friday campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the landing copy",
          HOLD,
          hub("complete_task", {
            key: "copy-done",
            summary: "Landing copy ready",
            artifacts: [{ kind: "text", label: "Landing copy", value: "Black Friday: 20% off everything" }],
          }),
        ].join("\n"),
        expected_output: "Three headlines and a short body",
      }),
      hub("delegate_task", {
        key: "build",
        hob: "Ada",
        brief: [
          "Build the campaign once the copy exists",
          hub("report_checkpoint", { key: "research", kind: "progress", summary: "Keyword research done" }),
        ].join("\n"),
        depends_on: ["$copy.task_id"],
      }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id", "$build.task_id"] }),
      // Aldric's next turn answers you; the two after it are the continuations that work arriving starts.
      `fake:then fake:then ${hub("hand_off", { key: "hand", artifact_id: "$copy-done.artifacts.0", to_task_id: "$build.task_id" })}`,
      `fake:then fake:then fake:then ${hub("complete_task", { key: "wrap", summary: "The Black Friday campaign is ready" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Both members start at once. Ada works while she waits on Quill's copy, which she never gets
    // from Quill himself; her Task waits.
    const waiting = await run(
      treeWhen((tree) => {
        const quill = ownedBy(tree, QUILL);
        return ownedBy(tree, ADA)?.state === "waiting" && quill?.state === "active" && tree.quests.length === 1;
      }),
    );
    const { quillTask, adaTask } = expectBothStarted(waiting, requests);

    // Aldric waits without blocking his chat: you still get an answer from him.
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, "How is it going?")));
    const chatted = await run(messagesWhen((all) => all.length === 4));
    expect(chatted.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    // Quill finishes; Aldric hands his copy to Ada, who finishes in her own session; Aldric wraps up.
    await release();
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(done.tasks[0]?.result?.summary).toBe("The Black Friday campaign is ready");
    expect(ownedBy(done, QUILL)?.state).toBe("completed");
    expect(ownedBy(done, ADA)?.state).toBe("completed");
    expect(done.handOffs.map((each) => each.toTaskId)).toEqual([adaTask?.id]);

    expectAdaResumed(done, requests, adaTask);

    // Two continuations in the chat: the hand-off, then the wrap-up with the Quest's result.
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    const [handing, wrapUp] = continuations(all);
    expect(handing?.content).toContain("hand_off: Handed Landing copy to Task");
    expect(wrapUp?.content).toContain(`finished. Its result:`);
    expect(wrapUp?.content).toContain("complete_task: Task");
    // Nothing is left for anyone to deal with, routine progress included: Ada's reached Aldric as a
    // digest along his next turns (#293), and what the wrap-up carries resolves once it has ended.
    for (const agentId of [ALDRIC, QUILL, ADA]) {
      const open = await run(
        retry(
          Effect.flatMap(
            Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId })),
            (items) => (items.length === 0 ? Effect.succeed(items) : Effect.fail("not yet" as const)),
          ),
        ),
      );
      expect(open).toEqual([]);
    }
    const digested = requests.filter((request) =>
      `${request.briefing ?? ""}${request.prompt}`.includes("Routine progress"),
    );
    expect(digested.map((request) => request.prompt)).toContain("How is it going?");
  }, 20_000);

  // covers OR-003, IN-005
  it("[TC-OR-091] a member whose turn ends with its milestones unreported is blocked, and its lead hears of it", async () => {
    const { run } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", { key: "copy", hob: "Quill", brief: "Draft the copy", milestones: ["Headlines"] }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "blocked"));
    const quill = ownedBy(tree, QUILL);
    const blocker = tree.checkpoints.find((each) => each.taskId === quill?.id && each.kind === "blocker");
    expect(blocker?.summary).toContain('milestone "Headlines" is not reached');
    // The blocker and the Failure reach Aldric as continuations in your chat.
    const all = await run(
      messagesWhen((each) => continuations(each).some((reply) => reply.content.includes("ended as blocked."))),
    );
    expect(continuations(all).some((reply) => reply.content.includes("A blocker was reported on Task"))).toBe(true);
  }, 20_000);
});

describe("a retired party member", () => {
  // covers OR-002
  it("[TC-OR-092] a member retired while it works fails its Task with a blocker that says why, and its lead hears of it", async () => {
    const { run } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Draft the copy", HOLD].join("\n") }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    await run(treeWhen((each) => each.attempts.some((attempt) => attempt.agentId === QUILL)));

    await run(HobLifecycle.use((lifecycle) => lifecycle.retire(QUILL, "stop")));

    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "failed"));
    const quill = ownedBy(tree, QUILL);
    const blocker = tree.checkpoints.find((each) => each.taskId === quill?.id && each.kind === "blocker");
    expect(blocker?.summary).toContain("retired");
    expect(tree.attempts.find((each) => each.taskId === quill?.id)?.state).toBe("interrupted");
    await run(messagesWhen((each) => continuations(each).some((reply) => reply.content.includes("ended as failed."))));
  }, 20_000);
});

describe("a party member's authority", () => {
  // covers PE-004, PE-006
  it("[TC-PE-160] a member's call that the delegation narrows to Ask asks you in the lead's thread, and runs once you approve", async () => {
    const { run } = setUp();
    const file = join(project, "copy.md");
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Write the copy to a file",
          `fake:tool Write ${file}`,
          hub("complete_task", { key: "copy-done", summary: "Copy written" }),
        ].join("\n"),
        authority: { decisions: { "edit-files": "ask" } },
      }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Balanced lets Quill edit on his own; the delegation made it ask, and it asks you, not Aldric.
    const pending = await run(
      retry(
        Effect.flatMap(
          ApprovalRepository.use((approvals) => approvals.listPending),
          (all): Effect.Effect<ApprovalRequest, "not yet"> =>
            all[0] === undefined ? Effect.fail("not yet") : Effect.succeed(all[0]),
        ),
      ),
    );
    expect(pending.agentId).toBe(QUILL);
    expect(pending.threadId).toBe(threadId);
    expect(pending.operation).toBe("edit-files");
    expect(pending.targets).toEqual([file]);
    // It is Quill's request on his own Task, not one of Aldric's messages.
    const asked = await run(treeWhen((each) => ownedBy(each, QUILL) !== undefined));
    expect(pending.messageId).toBeNull();
    expect(pending.taskId).toBe(ownedBy(asked, QUILL)?.id);

    await run(
      ApprovalService.use((approvals) =>
        approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest }),
      ),
    );
    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "completed"));
    const quill = ownedBy(tree, QUILL);
    expect(quill?.result?.summary).toBe("Copy written");
    // The call ran: it was recorded on Quill's Task before it ran (EX-004).
    expect(tree.checkpoints.some((each) => each.taskId === quill?.id && each.summary.includes("copy.md"))).toBe(true);
    const decided = await run(ApprovalService.use((approvals) => approvals.get(pending.id)));
    expect(decided.state).toBe("approved");
    expect(Option.isSome(Option.fromNullishOr(decided.decidedAt))).toBe(true);
  }, 20_000);

  it("[TC-PE-162] a member only reaches the folders its delegation gives it, even where its own policy reaches further", async () => {
    const { run } = setUp();
    const given = join(project, "copy");
    mkdirSync(given, { recursive: true });
    const inside = join(given, "draft.md");
    const outside = join(project, "secrets.md");
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Write the copy",
          `fake:tool Write ${inside}`,
          `fake:tool Write ${outside}`,
          hub("complete_task", { key: "copy-done", summary: "Copy written" }),
        ].join("\n"),
        authority: { folders: [given] },
      }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const tree = await run(treeWhen((each) => ownedBy(each, QUILL)?.state === "completed"));
    const quill = ownedBy(tree, QUILL);
    const ran = (path: string) =>
      tree.checkpoints.some(
        (each) => each.taskId === quill?.id && each.summary.includes(path.split("/").pop() ?? path),
      );
    // Balanced lets Quill edit the whole project; the delegation keeps him to the copy folder.
    expect(ran(inside)).toBe(true);
    expect(ran(outside)).toBe(false);
    expect(await run(ApprovalRepository.use((approvals) => approvals.listPending))).toEqual([]);
  }, 20_000);

  it("[TC-PE-163] a step a member plans works under the member's delegation too: its folders and its decisions", async () => {
    const { run } = setUp();
    const given = join(project, "steps");
    mkdirSync(given, { recursive: true });
    const step = [
      `fake:tool Read ${join(given, "outline.md")}`,
      `fake:tool Read ${join(project, "budget.md")}`,
      `fake:tool Write ${join(given, "notes.md")}`,
    ].join("\n");
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: ["Write the copy in steps", hub("plan_steps", { key: "plan", steps: [{ brief: step }] })].join("\n"),
        authority: { folders: [given], decisions: { "edit-files": "deny" } },
      }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const tree = await run(
      treeWhen((each) => {
        const quill = ownedBy(each, QUILL);
        const steps = each.tasks.filter((task) => task.parentId === quill?.id);
        return steps.length === 1 && steps.every((task) => task.state === "completed");
      }),
    );
    const quill = ownedBy(tree, QUILL);
    const stepTask = tree.tasks.find((task) => task.parentId === quill?.id);
    const ran = (file: string) =>
      tree.checkpoints.some((each) => each.taskId === stepTask?.id && each.summary.includes(file));
    // Balanced lets Quill read and edit the whole project; his delegation keeps his step to its
    // folder and takes editing away, as it does for Quill himself.
    expect(ran("outline.md")).toBe(true);
    expect(ran("budget.md")).toBe(false);
    expect(ran("notes.md")).toBe(false);
  }, 20_000);
});

// Issue #274: a member's question climbs to its nearest lead, who answers it or passes it up; one
// no lead can answer reaches you, and every answer goes back down to the hob that asked.

/** The questions in the request's tree once `ready` holds for them. */
const questionsWhen = (ready: (tree: TaskTree) => boolean) =>
  treeWhen(ready).pipe(Effect.map((tree) => tree.questions));

describe("questions in a party", () => {
  // covers OR-002, IN-004
  it("[TC-OR-130] Quill's question reaches Aldric, who answers it himself; it never reaches you and Quill goes on with the answer", async () => {
    const { run, requests } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the copy",
          hub("ask", { key: "tone", question: "Playful or formal?" }),
          `fake:then ${hub("complete_task", { key: "copy-done", summary: "Playful copy drafted" })}`,
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
      // Aldric's next turn is the one Quill's question starts; the one after it, Quill's result.
      `fake:then ${hub("answer", { key: "reply", question_id: "$tone.question_id", answer: "Playful" })}`,
      `fake:then fake:then ${hub("complete_task", { key: "wrap", summary: "Campaign planned" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const quill = ownedBy(done, QUILL);
    expect(quill?.result?.summary).toBe("Playful copy drafted");
    const [question] = done.questions;
    expect(question?.askerId).toBe(QUILL);
    expect(question?.chain).toEqual([]);
    expect(question?.answeredBy).toEqual({ _tag: "Lead", agentId: ALDRIC });
    expect(question?.answer).toBe("Playful");

    // Aldric heard the question in a continuation of his chat and was told how to answer it.
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    const [asked] = continuations(all);
    expect(asked?.content).toContain(`question ${question?.id} about Task ${quill?.id}`);
    expect(asked?.content).toContain("Playful or formal?");
    expect(asked?.content).toContain("pass it up with escalate");
    expect(asked?.content).toContain("answer: Answered");
    // Quill's next turn went on in his own session with Aldric's answer.
    const quillPrompts = promptsTo(requests, quill);
    expect(quillPrompts).toHaveLength(2);
    expect(quillPrompts[1]?.prompt).toContain('was answered by hob aldric: "Playful"');
    expect(quillPrompts[1]?.sessionId).not.toBeNull();
  }, 20_000);

  // covers OR-002, IN-002, IN-004
  it("[TC-OR-131] Ada's question that Aldric passes up reaches you, and your answer goes back down to her", async () => {
    const { run, requests } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "build",
        hob: "Ada",
        brief: [
          "Build the campaign",
          hub("ask", { key: "date", question: "Dec 12 for international?" }),
          `fake:then ${hub("complete_task", { key: "build-done", summary: "Built for Dec 12" })}`,
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$build.task_id"] }),
      `fake:then ${hub("escalate", { key: "up", question_id: "$date.question_id" })}`,
      `fake:then fake:then ${hub("complete_task", { key: "wrap", summary: "Campaign built" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Aldric passed it up: no lead is left, so it waits for you.
    const [waiting] = await run(questionsWhen((tree) => tree.questions[0]?.recipientId === null));
    expect(waiting?.chain).toEqual([ALDRIC]);
    expect(waiting?.state).toBe("open");
    // Once Aldric's turn that passed it up ends, nothing in any hob's backpack waits on it: it is yours.
    await run(
      retry(
        Effect.flatMap(
          Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: ALDRIC })),
          (items) =>
            items.some((item) => item.payload._tag === "question") ? Effect.fail("not yet" as const) : Effect.void,
        ),
      ),
    );

    if (waiting === undefined) throw new Error("no question");
    await run(QuestionService.use((questions) => questions.answer(waiting.id, "Yes, Dec 12")));

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const ada = ownedBy(done, ADA);
    expect(ada?.result?.summary).toBe("Built for Dec 12");
    expect(done.questions[0]?.answeredBy).toEqual({ _tag: "User" });
    const adaPrompts = promptsTo(requests, ada);
    expect(adaPrompts).toHaveLength(2);
    expect(adaPrompts[1]?.prompt).toContain('was answered by the user: "Yes, Dec 12"');
  }, 20_000);
});

describe("what reaches a lead", () => {
  // covers OR-002, IN-004
  it("[TC-OR-132] your note on Quill's Task reaches Aldric as a message about that Task, once, however often it is sent", async () => {
    const { run, release } = setUp();
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Draft the copy", HOLD].join("\n") }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));
    const started = await run(treeWhen((tree) => ownedBy(tree, QUILL) !== undefined));
    const quill = ownedBy(started, QUILL);
    if (quill === undefined) throw new Error("no Task for Quill");

    const key = NoteId.make("note-1");
    const leave = () => run(QuestionService.use((notes) => notes.leaveNote(quill.id, key, "Keep it short")));
    const note = await leave();
    expect(note.recipientId).toBe(ALDRIC);
    // Sent again, as a client retrying would, it is the same note and goes nowhere twice.
    expect(await leave()).toEqual(note);
    const reused = await run(
      QuestionService.use((notes) => notes.leaveNote(quill.id, key, "Make it long")).pipe(Effect.flip),
    );
    expect(reused._tag).toBe("NoteRefused");

    const all = await run(
      messagesWhen((each) => continuations(each).some((reply) => reply.content.includes("The user left a note"))),
    );
    const noted = continuations(all).filter((reply) => reply.content.includes("The user left a note"));
    expect(noted).toHaveLength(1);
    expect(noted[0]?.content).toContain(`The user left a note about Task ${quill.id}: Keep it short`);
    const tree = await run(treeWhen((each) => each.notes.length > 0));
    expect(tree.notes.map((each) => each.text)).toEqual(["Keep it short"]);
    // Quill never hears it from you: his session holds nothing of it.
    const quillItems = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: QUILL })));
    expect(quillItems.filter((item) => item.payload._tag === "message")).toEqual([]);
    await release();
  }, 20_000);

  // covers OR-003, IN-005
  it("[TC-OR-133] Quill's finding wakes Aldric with his routine progress folded in; the progress alone never does", async () => {
    const { run } = setUp();
    const progress = (n: number) => hub("report_checkpoint", { key: `p${n}`, kind: "progress", summary: `Draft ${n}` });
    const prompt = [
      "Plan the campaign",
      hub("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the copy",
          progress(1),
          progress(2),
          progress(3),
          hub("report_checkpoint", { key: "found", kind: "finding", summary: "The brand voice changed last week" }),
          hub("complete_task", { key: "copy-done", summary: "Copy drafted" }),
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
      // The finding and the result may arrive in one continuation or two: Aldric wraps up in whichever has both.
      `fake:then ${hub("complete_task", { key: "wrap", summary: "Campaign planned" })}`,
      `fake:then fake:then ${hub("complete_task", { key: "wrap-later", summary: "Campaign planned" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const all = await run(messagesWhen((each) => continuations(each).length >= 1));
    const woken = continuations(all);
    // The finding and the result woke Aldric, at most once each; three updates woke him no more.
    expect(woken.length).toBeGreaterThanOrEqual(1);
    expect(woken.length).toBeLessThanOrEqual(2);
    const finding = woken.find((reply) => reply.content.includes("A finding was reported on Task"));
    expect(finding?.content).toContain("The brand voice changed last week");
    expect(
      woken.every((reply) => !reply.content.includes("Work arrived for you while you were not running:\n\nRoutine")),
    ).toBe(true);
    // Quill's three updates and the hub's own "started" read as one line of the digest.
    const told = woken.map((reply) => reply.content).join("\n");
    expect(told).toContain("sent 4 updates. The latest: Draft 3");
  }, 20_000);
});
