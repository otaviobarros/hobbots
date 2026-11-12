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
import { StartFreshRefused, ThreadKeyReused, UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type BackpackItem,
  type Message,
  TaskId,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Backpack, DEFAULT_DISPATCH_LIMITS, Dispatcher } from "@hobbots/inbox";
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
import { Effect, Exit, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { BlockOnRetirement } from "../src/blockers.ts";
import { ContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1376 (ADR 037): Start fresh through the chat, with the real dispatcher. What the chat still
// owed moves to the new chat, its first turn is told what was carried over, and the work that waited
// there is delivered in the new chat exactly once, never in the old one.

const now = "2026-11-11T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const SHIRE = ThreadId.make("shire");
const FRESH = ThreadId.make("shire-fresh");

/** A prompt with this line keeps its turn running until it is stopped. */
const HOLD = "hold:";

/** The fake runtime, recording every prompt; a held prompt's turn never ends on its own. */
const recording = (requests: Array<PromptRequest>) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (request) => {
          requests.push(request);
          return request.prompt.startsWith(HOLD) ? Stream.never : fake.sendPrompt(request);
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));

const frodo = new Agent({
  id: FRODO,
  name: "Frodo",
  roleTitle: "Ring-bearer",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1,
  lookColor: "moss",
  configVersion: 1,
  createdAt: now,
});

/** Frodo and his chat, stored before the hub starts. */
const Frodo = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(frodo);
    yield* repo.upsertThread(
      new Thread({ id: SHIRE, agentId: FRODO, title: "The quest", kind: "chat", createdAt: now, updatedAt: now }),
    );
  }),
);

const makeApp = (requests: Array<PromptRequest>) =>
  Layer.mergeAll(WakeOnArrival, BlockOnRetirement, HobLifecycle.layer, TaskControls.layer).pipe(
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
    Layer.provideMerge(Frodo),
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
        recording(requests),
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
  const app = ManagedRuntime.make(makeApp(requests));
  runtime = app;
  return { run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect), requests };
};

const waitFor = <A, E, R>(effect: Effect.Effect<A, E | "not yet", R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));

const messagesOf = (threadId: ThreadId) => HobbotsRepository.use((repo) => repo.listMessages(threadId));

/** Frodo's Task in his chat, with one step that failed: returns the failure that waits for him there. */
const failedStep = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  const task = (id: string, parentId: string | null) => ({
    id: TaskId.make(id),
    ownerId: FRODO,
    parentId: parentId === null ? null : TaskId.make(parentId),
    threadId: SHIRE,
    brief: `Brief for ${id}`,
    dependsOn: [],
    createdAt: now,
  });
  yield* tasks.createTask({ task: task("quest", null), delegation: null, milestones: [] });
  const step = yield* tasks.createTask({ task: task("pass", "quest"), delegation: null, milestones: [] });
  const failed = yield* tasks.moveTask(step.value.id, step.value.revision, "failed", now);
  const entry = failed.entries.find((each) => each.payload._tag === "BackpackItemRecorded");
  return entry?.payload._tag === "BackpackItemRecorded" ? entry.payload.item : undefined;
});

/** The error a refused command failed with. */
const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : undefined;

const ended = (all: ReadonlyArray<Message>) => all.every((m) => m.status !== "streaming" && m.status !== "stopping");

describe("Start fresh", () => {
  // covers CH-009, IN-001, IN-005
  it("[TC-CH-1376-05] delivers what waited in the old chat once, in the new chat, whose first turn hears what was carried over", async () => {
    const { run, requests } = setUp();
    const result = await run(
      Effect.gen(function* () {
        const lifecycle = yield* HobLifecycle;
        const chat = yield* ChatService;
        // Paused, Frodo takes nothing, so the failure waits in his chat while it is started fresh.
        yield* lifecycle.pause(FRODO);
        const failure = (yield* failedStep) as BackpackItem;
        const started = yield* chat.startFresh(SHIRE, FRESH);
        const again = yield* chat.startFresh(SHIRE, FRESH);
        yield* lifecycle.wake(FRODO);
        const settled = yield* waitFor(
          Backpack.use((backpack) => backpack.find(failure.id)).pipe(
            Effect.flatMap((item) =>
              item.state === "resolved" ? Effect.succeed(item) : Effect.fail("not yet" as const),
            ),
          ),
        );
        const fresh = yield* waitFor(
          messagesOf(FRESH).pipe(
            Effect.flatMap((all) =>
              ended(all) && all.length > 0 ? Effect.succeed(all) : Effect.fail("not yet" as const),
            ),
          ),
        );
        return { started, again, settled, fresh, old: yield* messagesOf(SHIRE) };
      }),
    );

    expect(result.started.chat).toMatchObject({ id: FRESH, kind: "chat", origin: { threadId: SHIRE } });
    expect(result.started.carried.map((item) => item.ref._tag)).toEqual(["task", "backpack-item"]);
    // The same request sent again returns what it did and changes nothing.
    expect(result.again).toEqual(result.started);
    // Delivered once, into a turn of the new chat; the old chat never ran a turn.
    expect(result.settled.deliveries).toHaveLength(1);
    expect(result.settled.deliveries[0]?.target).toContain(FRESH);
    expect(result.old).toEqual([]);
    expect(result.fresh.filter((m) => m.role === "assistant")).toHaveLength(1);
    const [turn] = requests;
    expect(requests).toHaveLength(1);
    expect(turn?.briefing).toContain("Open work: Brief for quest (Task quest)");
    expect(turn?.briefing).toContain("Still to deal with: failure about Brief for pass");
  });

  // covers CH-009 (#1378: the Start fresh sheet lists what comes along before you choose it)
  it("[TC-CH-1378-01] lists what Start fresh would carry over, as it then carries it, and changes nothing", async () => {
    const { run } = setUp();
    const result = await run(
      Effect.gen(function* () {
        const lifecycle = yield* HobLifecycle;
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        yield* lifecycle.pause(FRODO);
        yield* failedStep;
        const before = yield* repo.carryOver(SHIRE);
        const again = yield* repo.carryOver(SHIRE);
        const started = yield* chat.startFresh(SHIRE, FRESH);
        return { before, again, started, old: yield* repo.carryOver(SHIRE), fresh: yield* repo.carryOver(FRESH) };
      }),
    );
    const listed = result.started.carried.map(({ ref, label }) => ({ ref, label }));
    expect(result.before).toEqual(listed);
    expect(result.before.map((item) => item.label)).toEqual(["Brief for quest", "failure about Brief for pass"]);
    // Reading it twice changes nothing; once carried, the work is in the new chat and the old one owes none.
    expect(result.again).toEqual(result.before);
    expect(result.old).toEqual([]);
    expect(result.fresh).toEqual(listed);
  });

  // covers CH-009
  it("[TC-CH-1376-06] refuses a camp, a chat no longer open, a reused key, and a chat whose reply is running", async () => {
    const { run } = setUp();
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const camp = yield* chat.makeCamp(FRODO, {
          key: ThreadId.make("camp"),
          title: "Mordor",
          goal: "Destroy the ring",
          private: false,
        });
        const onCamp = yield* Effect.exit(chat.startFresh(camp.id, ThreadId.make("k1")));
        const reusedKey = yield* Effect.exit(chat.startFresh(SHIRE, camp.id));
        // A reply running in the chat stops it, as it stops an archive.
        yield* chat.sendPrompt(SHIRE, `${HOLD} a long reply`);
        const running = yield* Effect.exit(chat.startFresh(SHIRE, ThreadId.make("k2")));
        yield* chat.stop(SHIRE);
        yield* waitFor(
          messagesOf(SHIRE).pipe(
            Effect.flatMap((all) => (ended(all) ? Effect.succeed(all) : Effect.fail("not yet" as const))),
          ),
        );
        const started = yield* chat.startFresh(SHIRE, ThreadId.make("k3"));
        const superseded = yield* Effect.exit(chat.startFresh(SHIRE, ThreadId.make("k4")));
        const sent = yield* Effect.exit(chat.sendPrompt(SHIRE, "Still there?"));
        return { onCamp, reusedKey, running, started, superseded, sent };
      }),
    );
    expect(refusal(result.onCamp)).toEqual(
      new StartFreshRefused({ threadId: ThreadId.make("camp"), reason: "not-open-chat" }),
    );
    expect(refusal(result.reusedKey)).toEqual(new ThreadKeyReused({ threadId: ThreadId.make("camp") }));
    expect(refusal(result.running)).toEqual(new StartFreshRefused({ threadId: SHIRE, reason: "reply-running" }));
    expect(result.started.carried).toEqual([]);
    expect(refusal(result.superseded)).toEqual(new StartFreshRefused({ threadId: SHIRE, reason: "not-open-chat" }));
    // The chat it replaced is read-only for good.
    expect(refusal(result.sent)).toMatchObject({ _tag: "ThreadArchived", threadId: SHIRE });
  });
});
