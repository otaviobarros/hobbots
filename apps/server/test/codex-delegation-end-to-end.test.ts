import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  QuestionService,
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
  OWNER_ACTOR,
  OWNER_USER_ID,
  type RuntimeKind,
  type TaskTree,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { CodexLayer, FakeRuntimeLayer, ProcessSandbox } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Schedule } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { codexStandIn, standInTurns } from "./codex-stand-in.ts";

// Issue #440: a Codex hob delegates and reports through hub tools like a Claude hob. The hub runs the
// real Codex adapter against a stand-in Codex, whose model follows `fake:hub` lines, and the fake
// runtime plays the Claude hobs.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-codex-delegation-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
mkdirSync(project, { recursive: true });
const codexFolder = join(temp, "codex");
const codex = codexStandIn(codexFolder);

const now = "2026-11-03T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const aldricThread = ThreadId.make("aldric-thread");
const pipThread = ThreadId.make("pip-thread");

const hob = (id: AgentId, name: string, runtime: RuntimeKind) =>
  new Agent({
    id,
    name,
    roleTitle: "Marketing",
    runtime,
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Every hob works in the project folder under the Balanced preset. */
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
        commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
      }),
  }),
);

/** What the Claude hobs were sent, in order. */
const claudeRequests: Array<PromptRequest> = [];

const RecordedClaude = Layer.effect(
  RuntimeAdapter,
  Effect.gen(function* () {
    const fake = yield* RuntimeAdapter;
    return RuntimeAdapter.of({
      ...fake,
      sendPrompt: (request) => {
        claudeRequests.push(request);
        return fake.sendPrompt(request);
      },
    });
  }),
).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

const Party = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(hob(ALDRIC, "Aldric", "claude-code"));
    yield* repo.insertAgent(hob(QUILL, "Quill", "claude-code"));
    yield* repo.insertAgent(hob(PIP, "Pip", "codex"));
    for (const [id, agentId, title] of [
      [aldricThread, ALDRIC, "Launch"],
      [pipThread, PIP, "Copy"],
    ] as const) {
      yield* repo.upsertThread(new Thread({ id, agentId, title, createdAt: now, updatedAt: now }));
    }
  }),
);

const Hub = Layer.mergeAll(WakeOnArrival, HobLifecycle.layer, TaskControls.layer).pipe(
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
  Layer.provideMerge(GrantService.layer),
  Layer.provideMerge(Party),
  Layer.provideMerge(
    Layer.mergeAll(
      HobbotsRepositoryLive,
      TaskRepositoryLive,
      TaskToolCallsLive,
      ApprovalRepositoryLive,
      GrantRepositoryLive,
      BackpackLive,
      EventJournal.layer,
      EventBus.layer,
      NodeFolderChecks,
      ProjectTools,
      HobAdmission.layer,
      RecordedClaude,
      CodexLayer({ executable: codex, clientVersion: "0.0.0", workspaceDir: join(temp, "workspace") }).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            PolicyEngine.node,
            ProcessSandbox.unavailable("Hub tools need no sandbox."),
          ),
        ),
      ),
      Layer.succeed(UserSession, {
        deviceId: WINDOW_DEVICE_ID,
        name: "This computer's Hobbots window",
        kind: "window",
        userId: OWNER_USER_ID,
        actor: OWNER_ACTOR,
        whileApproved: (write) => write,
      }),
    ),
  ),
  Layer.provideMerge(TestDatabase),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof Hub>, Layer.Error<typeof Hub>> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  claudeRequests.length = 0;
});

const start = async () => {
  runtime = ManagedRuntime.make(Hub);
  await runtime.runPromise(Effect.void);
  const hub = runtime;
  return <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof Hub>>) => hub.runPromise(effect);
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 1500 }));

/** Once `holds` is true, checked again on each retry. */
const eventually = (holds: () => boolean) =>
  retry(Effect.suspend(() => (holds() ? Effect.void : Effect.fail("not yet" as const))));

const hubLine = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

const send = (threadId: ThreadId, prompt: ReadonlyArray<string>) =>
  ChatService.use((chat) => chat.sendPrompt(threadId, prompt.join("\n")));

/** The thread's Task tree once `ready` holds for it and no Attempt is live. */
const settledTree = (threadId: ThreadId, ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      const live = tree?.attempts.some((each) => each.state === "starting" || each.state === "running");
      return tree !== undefined && !live && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

/** The thread's messages once `ready` holds for them, every reply ended. */
const messagesWhen = (threadId: ThreadId, ready: (all: ReadonlyArray<Message>) => boolean) =>
  retry(
    Effect.gen(function* () {
      const all = yield* HobbotsRepository.use((repo) => repo.listMessages(threadId));
      const ended = all.every((m) => m.status !== "streaming" && m.status !== "stopping");
      return ended && ready(all) ? all : yield* Effect.fail("not yet" as const);
    }),
  );

describe("delegating between Codex and Claude hobs", () => {
  // covers OR-001, OR-002, RT-001, AG-005, ADR 024
  it("[TC-RT-084] a Claude hob delegates to a Codex hob, which completes its Task through hub tools, and gets the result", {
    timeout: 60_000,
  }, async () => {
    const run = await start();
    await run(
      send(aldricThread, [
        "Get the copy checked",
        hubLine("delegate_task", {
          key: "to-pip",
          hob: "Pip",
          brief: [
            "Check the copy",
            hubLine("complete_task", { delivered: true, key: "pip-done", summary: "Pip checked the copy" }),
          ].join("\n"),
        }),
      ]),
    );
    const tree = await run(
      settledTree(aldricThread, (each) =>
        each.tasks.some((task) => task.ownerId === PIP && task.state === "completed"),
      ),
    );
    const pipTask = tree.tasks.find((task) => task.ownerId === PIP);
    expect(pipTask?.result?.summary).toBe("Pip checked the copy");

    // Pip's turn ran on Codex, and the hub answered its call to complete_task.
    const pipTurn = standInTurns(codexFolder).find((turn) => turn.input.includes("Check the copy"));
    expect(pipTurn?.answers).toEqual([expect.objectContaining({ tool: "complete_task", success: true })]);

    // The result reached Aldric, on Claude Code.
    await run(eventually(() => claudeRequests.some((request) => request.prompt.includes("Pip checked the copy"))));
  });

  // covers OR-001, OR-002, RT-001, AG-005, ADR 024
  it("[TC-RT-085] a Codex hob delegates to a Claude hob through hub tools, and gets the result on Codex", {
    timeout: 60_000,
  }, async () => {
    const run = await start();
    await run(
      send(pipThread, [
        "Get the copy drafted",
        hubLine("delegate_task", {
          key: "to-quill",
          hob: "Quill",
          brief: [
            "Draft the copy",
            hubLine("complete_task", { delivered: true, key: "quill-done", summary: "Quill drafted the copy" }),
          ].join("\n"),
        }),
      ]),
    );
    const tree = await run(
      settledTree(pipThread, (each) => each.tasks.some((task) => task.ownerId === QUILL && task.state === "completed")),
    );
    expect(tree.tasks.find((task) => task.ownerId === QUILL)?.result?.summary).toBe("Quill drafted the copy");

    // Pip's call to delegate_task was answered by the hub, and showed as a step of its reply.
    const delegated = standInTurns(codexFolder).find((turn) => turn.input.includes("Get the copy drafted"));
    expect(delegated?.answers).toEqual([expect.objectContaining({ tool: "delegate_task", success: true })]);
    const messages = await run(messagesWhen(pipThread, (all) => all.some((m) => m.role === "assistant")));
    const reply = messages.find((m) => m.role === "assistant");
    expect(reply?.steps).toContainEqual(expect.objectContaining({ kind: "tool", state: "done" }));

    // Quill's result reached Pip in a later turn of the same Codex thread.
    const thread = delegated?.thread;
    await run(
      eventually(() =>
        standInTurns(codexFolder).some(
          (turn) => turn.thread === thread && turn.input.includes("Quill drafted the copy"),
        ),
      ),
    );
  });
});
