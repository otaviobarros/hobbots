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
  QuestionService,
  RuntimeAdapter,
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
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Dispatcher } from "@hobbots/inbox";
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
import { Effect, Layer, ManagedRuntime, Schedule } from "effect";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// A hub for the first full run's party (#563): Frodo leads in his chat and brings in Quill, Rook,
// Pip and Nettle. The fake runtime plays every hob from `fake:hub` lines; nobody prompts after the
// first message unless a test sends another.

const now = "2026-11-03T00:00:00.000Z";
export const FRODO = AgentId.make("frodo");
export const QUILL = AgentId.make("quill");
export const ROOK = AgentId.make("rook");
export const PIP = AgentId.make("pip");
export const NETTLE = AgentId.make("nettle");
export const threadId = ThreadId.make("first-run");

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Engineer",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** A prompt line that makes the fake call a Task tool. */
export const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/**
 * The request with its hub calls' answers kept in `answers`. A call whose key has a gate in `gates`
 * is made once that gate resolves, as a model would call it only after something happened.
 */
const answering = (
  request: PromptRequest,
  answers: Map<string, string>,
  gates: ReadonlyMap<string, () => Promise<void>>,
): PromptRequest => {
  const hubTools = request.hubTools;
  if (!hubTools) return request;
  const gateOf = (input: unknown) => {
    const key = (input as { readonly key?: unknown } | null)?.key;
    const gate = typeof key === "string" ? gates.get(key) : undefined;
    return gate === undefined ? Effect.void : Effect.promise(gate);
  };
  const call: typeof hubTools.call = (name, input, step) =>
    Effect.tap(Effect.andThen(gateOf(input), hubTools.call(name, input, step)), (answer) =>
      Effect.sync(() => {
        const key = (input as { readonly key?: unknown } | null)?.key;
        if (typeof key === "string") answers.set(key, answer.text);
      }),
    );
  return { ...request, hubTools: { ...hubTools, call } };
};

/** Lines a later prompt runs once it carries `on`, as a hob reacts to what reaches it. */
export interface Reaction {
  readonly on: string;
  readonly lines: ReadonlyArray<string>;
}

/** The prompt with the first reaction it carries added; each reaction runs once. */
const reacted = (prompt: string, reactions: Array<Reaction>) => {
  const index = reactions.findIndex((each) => prompt.includes(each.on));
  return index === -1 ? prompt : [prompt, ...(reactions.splice(index, 1)[0]?.lines ?? [])].join("\n");
};

/** The hub's services, a temporary project folder, and what each scripted call was answered. */
export const partyHub = () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-party-")));
  const project = join(temp, "project");
  mkdirSync(project, { recursive: true });
  const requests: Array<PromptRequest> = [];
  /** What the hub answered each scripted call, by the call's key: what the hob read back. */
  const answers = new Map<string, string>();
  /** Gates on scripted calls, by the call's key: see `answering`. */
  const gates = new Map<string, () => Promise<void>>();
  const reactions: Array<Reaction> = [];

  const tools = Layer.succeed(
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

  const recording = Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (sent) => {
          const request = answering({ ...sent, prompt: reacted(sent.prompt, reactions) }, answers, gates);
          requests.push(request);
          return fake.sendPrompt(request);
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

  const party = Layer.effectDiscard(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      for (const [id, name] of [
        [FRODO, "Frodo"],
        [QUILL, "Quill"],
        [ROOK, "Rook"],
        [PIP, "Pip"],
        [NETTLE, "Nettle"],
      ] as const) {
        yield* repo.insertAgent(hob(id, name));
      }
      yield* repo.upsertThread(
        new Thread({ id: threadId, agentId: FRODO, title: "First run", createdAt: now, updatedAt: now }),
      );
    }),
  );

  const app = Layer.mergeAll(WakeOnArrival, HobLifecycle.layer).pipe(
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
    Layer.provideMerge(party),
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
        tools,
        HobAdmission.layer,
        recording,
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
  const runtime = ManagedRuntime.make(app);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof app>>) => runtime.runPromise(effect);
  const dispose = async () => {
    await runtime.dispose();
    rmSync(temp, { recursive: true, force: true });
  };
  return { run, dispose, requests, answers, reactions, gates };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1000 }));

export const isLive = (state: string) => state === "starting" || state === "running";

/** Sends your message to Frodo in his thread. */
export const send = (lines: ReadonlyArray<string>) =>
  ChatService.use((chat) => chat.sendPrompt(threadId, lines.join("\n")));

/** The request's whole tree once `ready` holds for it. */
export const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      return tree !== undefined && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

/** The thread's messages once `ready` holds for them, every reply ended. */
export const messagesWhen = (ready: (all: ReadonlyArray<Message>) => boolean) =>
  retry(
    Effect.gen(function* () {
      const all = yield* HobbotsRepository.use((repo) => repo.listMessages(threadId));
      const ended = all.every((m) => m.status !== "streaming" && m.status !== "stopping");
      return ended && ready(all) ? all : yield* Effect.fail("not yet" as const);
    }),
  );

/** A reply with no message of yours before it: a continuation Hobbots started. */
export const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

/** The Task a hob owns under the one you asked for. */
export const ownedBy = (tree: TaskTree, agentId: AgentId): Task | undefined =>
  tree.tasks.find((task) => task.ownerId === agentId && task.parentId !== null);
