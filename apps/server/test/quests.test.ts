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
    const quillTask = ownedBy(waiting, QUILL);
    const adaTask = ownedBy(waiting, ADA);
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

    const adaPrompts = promptsTo(requests, adaTask);
    expect(adaPrompts).toHaveLength(2);
    expect(adaPrompts[1]?.prompt).toContain('"Landing copy" was handed to Task');
    expect(adaPrompts[1]?.prompt).toContain("Black Friday: 20% off everything");
    // The same session goes on: she keeps what she did while she waited.
    const adaAttempts = done.attempts.filter((each) => each.taskId === adaTask?.id);
    expect(adaAttempts.map((each) => each.state)).toEqual(["completed", "completed"]);
    expect(adaPrompts[1]?.sessionId).toBe(adaAttempts[0]?.sessionId);

    // Two continuations in the chat: the hand-off, then the wrap-up with the Quest's result.
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    const [handing, wrapUp] = continuations(all);
    expect(handing?.content).toContain("hand_off: Handed Landing copy to Task");
    expect(wrapUp?.content).toContain(`finished. Its result:`);
    expect(wrapUp?.content).toContain("complete_task: Task");
    // Nothing is left for anyone to deal with.
    for (const agentId of [ALDRIC, QUILL, ADA]) {
      const open = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId })));
      expect(open.filter((item) => item.actionable)).toEqual([]);
    }
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
});
