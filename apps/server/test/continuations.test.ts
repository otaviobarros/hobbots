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
import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  type BackpackItem,
  Message,
  MessageId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack, Dispatcher } from "@hobbots/inbox";
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
import { Deferred, Effect, Layer, ManagedRuntime, Schedule, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// The one wake path of ADR 019: work that arrives for a hob whose turn has ended starts a
// continuation in its thread, with the fake runtime scripting what that turn does.

const now = "2026-11-02T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
/** A chat prompt with this line keeps its turn running until the test lets it end. */
const HOLD = "fake:hold";

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
          return request.prompt.includes(HOLD)
            ? stream.pipe(Stream.concat(Stream.fromEffect(Deferred.await(gate)).pipe(Stream.drain)))
            : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));

/** What the hub's records hold before it starts, as after a restart. */
type Before = Layer.Layer<never, never, HobbotsRepository | TaskRepository | ApprovalRepository>;

const makeApp = (gate: Deferred.Deferred<void>, requests: Array<PromptRequest>, before: Before) =>
  Layer.mergeAll(WakeOnArrival, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(
      ContinuationsLive.pipe(Layer.provideMerge(Dispatcher.layer()), Layer.provideMerge(DispatcherHostLive)),
    ),
    Layer.provideMerge(
      StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
    ),
    Layer.provideMerge(ApprovalService.layer),
    Layer.provideMerge(before),
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
        held(gate, requests),
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
const threadId = ThreadId.make("shire");

/** Frodo and his thread, stored before the hub starts. */
const Frodo: Before = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(frodo);
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
    );
  }),
);

const setUp = (before: Before = Frodo) => {
  const requests: Array<PromptRequest> = [];
  const gate = Deferred.makeUnsafe<void>();
  const app = ManagedRuntime.make(makeApp(gate, requests, before));
  runtime = app;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<App>>) => app.runPromise(effect);
  return { run, requests, release: () => run(Deferred.succeed(gate, undefined)) };
};

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));

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

/** Frodo's backpack items, settled or not. */
const itemsOf = (ids: ReadonlyArray<BackpackItem["id"]>) =>
  Effect.forEach(ids, (id) => Backpack.use((b) => b.find(id)));

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** A reply with no message of yours before it: a continuation Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

describe("continuing a hob when work arrives", () => {
  // covers IN-004, EX-003
  it("[TC-OR-080] a step's result that arrives after the turn ended starts a continuation, which completes the Task", async () => {
    const { run, requests } = setUp();
    // Frodo plans one step, and scripts what his next turn does: return the Task's result.
    const prompt = [
      "Carry the ring to Mordor",
      hub("plan_steps", { key: "plan", steps: [{ brief: "Walk to Mordor" }] }),
      `fake:then ${hub("complete_task", { key: "done", summary: "The ring is destroyed" })}`,
    ].join("\n");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, prompt)));

    // Nobody writes again: the step's result wakes Frodo, and his continuation completes the Task.
    const tree = await run(
      retry(
        Effect.gen(function* () {
          const [found] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
          return found?.tasks[0]?.state === "completed" ? found : yield* Effect.fail("not yet" as const);
        }),
      ),
    );
    expect(tree.tasks[0]?.result?.summary).toBe("The ring is destroyed");
    const all = await run(messagesWhen((each) => each.length === 3));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(continuations(all)).toHaveLength(1);
    const [continuation] = continuations(all);
    expect(continuation?.content).toContain("complete_task: ");

    // Its prompt was Hobbots' own, naming what arrived, in the thread's session.
    const asked = requests.find((request) => request.prompt.startsWith("Hobbots wrote this, not the user."));
    expect(asked?.prompt).toContain("finished. Its result:");
    expect(asked?.sessionId).not.toBeNull();

    // The result it carried was consumed by the Task's completion, under the dispatcher's claim.
    const open = await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO })));
    expect(open.filter((item) => item.actionable)).toEqual([]);
  });

  // covers IN-004, CH-008
  it("[TC-OR-081] your queued message starts first after a busy turn, and the work rides along it as context", async () => {
    const { run, requests, release } = setUp();
    await run(
      ChatService.use((chat) =>
        chat.sendPrompt(
          threadId,
          ["Carry the ring", HOLD, hub("plan_steps", { key: "plan", steps: [{ brief: "Walk" }] })].join("\n"),
        ),
      ),
    );
    // The step finishes while Frodo's turn still runs: its result waits for that turn to end.
    const waiting = await run(
      retry(
        Effect.gen(function* () {
          const open = yield* Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO }));
          const results = open.filter((item) => item.kind === "result");
          return results.length === 1 ? results : yield* Effect.fail("not yet" as const);
        }),
      ),
    );
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, "Where are we?")));
    await release();

    const all = await run(messagesWhen((each) => each.length === 4));
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(all[2]?.content).toBe("Where are we?");
    expect(continuations(all)).toEqual([]);
    const answered = requests.find((request) => request.prompt === "Where are we?");
    expect(answered?.briefing).toContain("Hobbots adds this, not the user.");
    expect(answered?.briefing).toContain("finished. Its result:");
    const [item] = await run(itemsOf(waiting.map((each) => each.id)));
    expect(item?.disposition).toEqual({ _tag: "consumed", by: all[3]?.id });
  });

  // covers IN-004, AG-006
  it("[TC-OR-082] a paused hob keeps what arrived, and the continuation starts once it wakes", async () => {
    const { run } = setUp();
    await run(HobLifecycle.use((hobs) => hobs.pause(FRODO)));
    // A step of Frodo's Task fails while he is paused: its Failure is his to read.
    const failure = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const task = (id: string, parentId: string | null) => ({
          id: TaskId.make(id),
          ownerId: FRODO,
          parentId: parentId === null ? null : TaskId.make(parentId),
          threadId,
          brief: `Brief for ${id}`,
          dependsOn: [],
          createdAt: now,
        });
        yield* tasks.createTask({ task: task("quest", null), delegation: null, milestones: [] });
        const step = yield* tasks.createTask({ task: task("pass", "quest"), delegation: null, milestones: [] });
        const failed = yield* tasks.moveTask(step.value.id, step.value.revision, "failed", now);
        const entry = failed.entries.find((each) => each.payload._tag === "BackpackItemRecorded");
        return entry?.payload._tag === "BackpackItemRecorded" ? entry.payload.item : undefined;
      }),
    );
    if (failure === undefined) throw new Error("no Failure recorded");
    expect(failure.kind).toBe("failure");
    const id = failure.id;

    // Paused, nothing starts and the item stays pending.
    await run(Effect.sleep("150 millis"));
    expect(await run(messages())).toEqual([]);
    expect((await run(itemsOf([id])))[0]?.state).toBe("pending");

    await run(HobLifecycle.use((hobs) => hobs.wake(FRODO)));
    const all = await run(messagesWhen((each) => each.length === 1));
    expect(all[0]?.role).toBe("assistant");
    expect(all[0]?.content).toContain("ended as failed.");
    const [settled] = await run(
      retry(
        Effect.flatMap(itemsOf([id]), (items) =>
          items[0]?.state === "resolved" ? Effect.succeed(items) : Effect.fail("not yet" as const),
        ),
      ),
    );
    expect(settled?.disposition).toEqual({ _tag: "consumed", by: all[0]?.id });
  });

  // covers IN-004, PE-007
  it("[TC-OR-083] a request that expired when Hobbots restarted reaches its hob as a continuation", async () => {
    const pending = new ApprovalRequest({
      id: ApprovalId.make("push"),
      agentId: FRODO,
      threadId,
      messageId: MessageId.make("before-restart"),
      stepId: "tool-1",
      tool: "Bash",
      operation: "push",
      targets: ["origin main"],
      arguments: { command: "git push origin main" },
      label: "Running git push origin main",
      reason: "Pushing asks first.",
      actionDigest: "d".repeat(64),
      policyVersion: "r1",
      onceOnly: false,
      state: "pending",
      denyReason: null,
      createdAt: now,
      decidedAt: null,
    });
    const { run } = setUp(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const repo = yield* HobbotsRepository;
          yield* repo.insertAgent(frodo);
          yield* repo.upsertThread(
            new Thread({ id: threadId, agentId: FRODO, title: "The quest", createdAt: now, updatedAt: now }),
          );
          // The reply that asked was still running when Hobbots stopped.
          yield* repo.upsertMessage(
            new Message({
              id: pending.messageId,
              threadId,
              role: "assistant",
              content: "Pushing the ring's map",
              status: "streaming",
              error: null,
              configVersion: 1,
              createdAt: now,
            }),
          );
          yield* ApprovalRepository.use((approvals) => approvals.insert(pending));
        }),
      ),
    );
    // The reply that asked was interrupted by the restart; the continuation follows it.
    const all = await run(messagesWhen((each) => each.length === 2));
    expect(all[0]?.status).toBe("interrupted");
    expect(all[1]?.content).toContain('The approval you asked for, "Running git push origin main", ended as expired.');
    expect(all[1]?.content).toContain("That tool call never ran.");
    expect((await run(ApprovalService.use((approvals) => approvals.get(pending.id)))).state).toBe("expired");
  });
});
