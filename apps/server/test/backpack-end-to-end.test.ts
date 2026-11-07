import {
  ApprovalService,
  ChatService,
  Continuations,
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
  type BackpackItem,
  type Message,
  type Task,
  type TaskTree,
  Thread,
  ThreadId,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import {
  Backpack,
  DEFAULT_DISPATCH_LIMITS,
  Dispatcher,
  type DispatchLimits,
  decideBlocker,
  RESULT_IN_BRIEFING,
} from "@hobbots/inbox";
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
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Schedule, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { BlockersHostLive, BlockOnRetirement } from "../src/blockers.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #298: the durable backpack end to end (ADR 019). Aldric leads Quill, and Ada when he needs
// her, on a Quest in your chat. The fake runtime scripts every hob, and faults are injected where
// the slice must hold: a member's call held back, a lead's continuation cut off or stalled, a
// claim's renewals frozen, and a hub that stops between a child finishing and its lead hearing of
// it. Nobody prompts after the first message, except to retry a blocker.

const now = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const threadId = ThreadId.make("launch");
/** How every continuation's prompt starts (ADR 019). */
const CONTINUATION = "Hobbots wrote this, not the user.";

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** What one of Aldric's continuations does, as a model would decide it. */
interface Script {
  /** The hub calls it makes. */
  readonly lines?: ReadonlyArray<string>;
  /** Cut off by the provider once its calls are made, before it ends. */
  readonly cut?: boolean;
  /** Stalled before the runtime starts it, until the hub's `stall` gate opens. */
  readonly stall?: boolean;
}

/** The faults and scripts a test injects into one hub, changed as the test goes. */
interface Faults {
  /** Scripts for Aldric's next continuations, in order; a continuation with none does nothing. */
  readonly scripts: Array<Script>;
  /** Hub calls, by key, held before they run until their gate opens. */
  readonly held: Map<string, Deferred.Deferred<void>>;
  /** Opens to let a stalled continuation go on. */
  readonly stall: Deferred.Deferred<void>;
  /** The hub stops as it is about to tell a lead of its work: nothing more reaches a thread. */
  crashBeforeNotify: boolean;
  /** Claims are no longer renewed, as by a worker that is paused or cut off from the database. */
  freezeRenewals: boolean;
}

const makeFaults = (scripts: Array<Script> = []): Faults => ({
  scripts,
  held: new Map(),
  stall: Deferred.makeUnsafe<void>(),
  crashBeforeNotify: false,
  freezeRenewals: false,
});

/** Holds the hub call with this key until `releaseCall`. */
const holdCall = (faults: Faults, key: string) => faults.held.set(key, Deferred.makeUnsafe<void>());

/** The request with each held call waiting for its gate before it runs. */
const holding = (request: PromptRequest, faults: Faults): PromptRequest => {
  const hubTools = request.hubTools;
  if (!hubTools) return request;
  const call: typeof hubTools.call = (name, input, step) => {
    const key = (input as { readonly key?: unknown } | null)?.key;
    const gate = typeof key === "string" ? faults.held.get(key) : undefined;
    return gate === undefined
      ? hubTools.call(name, input, step)
      : Effect.andThen(Deferred.await(gate), hubTools.call(name, input, step));
  };
  return { ...request, hubTools: { ...hubTools, call } };
};

/** The fake runtime, recording every prompt and playing each continuation's script. */
const runtimeOf = (requests: Array<PromptRequest>, faults: Faults) =>
  Layer.effect(
    RuntimeAdapter,
    Effect.gen(function* () {
      const fake = yield* RuntimeAdapter;
      return RuntimeAdapter.of({
        ...fake,
        sendPrompt: (sent) => {
          const request = holding(sent, faults);
          requests.push(request);
          if (!request.prompt.startsWith(CONTINUATION)) return fake.sendPrompt(request);
          const script = faults.scripts.shift() ?? {};
          const prompt = [...(script.cut ? ["fake:cut-off"] : []), request.prompt, ...(script.lines ?? [])].join("\n");
          const stream = fake.sendPrompt({ ...request, prompt });
          return script.stall ? Stream.unwrap(Effect.as(Deferred.await(faults.stall), stream)) : stream;
        },
      });
    }),
  ).pipe(Layer.provide(FakeRuntimeLayer()));

/** Thread continuations, which never start once the hub has stopped. */
const crashable = (faults: Faults) =>
  Layer.effect(
    Continuations,
    Effect.gen(function* () {
      const live = yield* Continuations;
      return Continuations.of({
        ...live,
        deliver: (thread, agentId, turn) =>
          Effect.suspend(() => (faults.crashBeforeNotify ? Effect.never : live.deliver(thread, agentId, turn))),
      });
    }),
  ).pipe(Layer.provide(ContinuationsLive));

/** The backpack, whose claims stop being renewed while renewals are frozen. */
const freezable = (faults: Faults) =>
  Layer.effect(
    Backpack,
    Effect.gen(function* () {
      const live = yield* Backpack;
      return Backpack.of({
        ...live,
        renew: (itemId, held, lease) =>
          Effect.suspend(() => (faults.freezeRenewals ? Effect.never : live.renew(itemId, held, lease))),
      });
    }),
  ).pipe(Layer.provide(BackpackLive));

const NoTools = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));

/** Quick retries, so a test that exhausts them stays short. */
const LIMITS: DispatchLimits = { ...DEFAULT_DISPATCH_LIMITS, firstRetry: "5 millis", maxRetry: "20 millis" };

/**
 * A lease short enough to run out within a test, yet long enough for a healthy claim to last on a
 * loaded runner: a claim lives on its first lease until its turn has been planned, checked and
 * delivered and a third of a lease has passed. At 300 milliseconds a slow database let a claim
 * nobody froze run out there, and its item was delivered a third time.
 */
const SHORT_LEASE = "1500 millis";

type Database = Layer.Layer<Layer.Success<typeof TestDatabase>>;

const makeHub = (database: Database, requests: Array<PromptRequest>, faults: Faults, limits: DispatchLimits) =>
  Layer.mergeAll(WakeOnArrival, BlockOnRetirement, HobLifecycle.layer).pipe(
    Layer.provideMerge(ChatService.layer),
    Layer.provideMerge(crashable(faults)),
    Layer.provideMerge(
      StepRunnerLive().pipe(
        Layer.provideMerge(MemberContinuationsLive),
        Layer.provideMerge(TaskTools.layer("/")),
        Layer.provideMerge(TaskSignal.layer),
      ),
    ),
    Layer.provideMerge(Dispatcher.layer(limits).pipe(Layer.provideMerge(DispatcherHostLive))),
    Layer.provideMerge(Layer.mergeAll(ApprovalService.layer, QuestionService.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ApprovalRepositoryLive,
        freezable(faults),
        EventJournal.layer,
        EventBus.layer,
        NodeFolderChecks,
        NoTools,
        HobAdmission.layer,
        runtimeOf(requests, faults),
        Layer.succeed(UserSession, {
          deviceId: WINDOW_DEVICE_ID,
          name: "This computer's Hobbots window",
          kind: "window",
          whileApproved: (write) => write,
        }),
      ),
    ),
    Layer.provideMerge(database),
  );

type Hub = ReturnType<typeof makeHub>;
type HubRuntime = ManagedRuntime.ManagedRuntime<Layer.Success<Hub>, Layer.Error<Hub>>;

const open: Array<HubRuntime> = [];
let databaseScope: Scope.Closeable | undefined;

afterEach(async () => {
  // A hub that stopped mid-way never ended its work, as after a crash; it goes last, with the database.
  for (const each of open.reverse()) await each.dispose();
  open.length = 0;
  if (databaseScope !== undefined) await Effect.runPromise(Scope.close(databaseScope, Exit.void));
  databaseScope = undefined;
});

/** One database that outlives every hub started over it. */
const sharedDatabase = async (): Promise<Database> => {
  const scope = await Effect.runPromise(Scope.make());
  databaseScope = scope;
  return Layer.succeedContext(await Effect.runPromise(Layer.buildWithScope(TestDatabase, scope)));
};

/** Starts a hub over the database: what it does at start runs before this returns. */
const start = async (database: Database, faults: Faults = makeFaults(), limits: DispatchLimits = LIMITS) => {
  const requests: Array<PromptRequest> = [];
  const runtime: HubRuntime = ManagedRuntime.make(makeHub(database, requests, faults, limits));
  open.push(runtime);
  await runtime.runPromise(Effect.void);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<Hub>>) => runtime.runPromise(effect);
  const releaseCall = (key: string) => {
    const gate = faults.held.get(key);
    faults.held.delete(key);
    return gate === undefined ? Promise.resolve() : run(Deferred.succeed(gate, undefined));
  };
  return { run, requests, faults, releaseCall, unstall: () => run(Deferred.succeed(faults.stall, undefined)) };
};

const hob = (id: AgentId, name: string, roleTitle: string) =>
  new Agent({
    id,
    name,
    roleTitle,
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** The party and your chat with Aldric, stored before anything runs. */
const party = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const each of [hob(ALDRIC, "Aldric", "Lead"), hob(QUILL, "Quill", "Copywriter"), hob(ADA, "Ada", "Reviewer")]) {
    yield* repo.insertAgent(each);
  }
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "The launch", createdAt: now, updatedAt: now }),
  );
});

/** Your first message: Aldric gives Quill the copy, with `brief` scripting her turn, and waits for it. */
const plan = (brief: ReadonlyArray<string>) =>
  [
    "Plan the launch",
    hub("delegate_task", { key: "copy", hob: "Quill", brief: ["Draft the launch copy", ...brief].join("\n") }),
    hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
  ].join("\n");

/** Quill finishes her Task. */
const quillDone = hub("complete_task", { delivered: true, key: "copy-done", summary: "The launch copy is ready" });
/** Aldric wraps the launch up. */
const wrapUp = (key = "wrap") => hub("complete_task", { delivered: true, key, summary: "The launch is ready" });

const retry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 800 }));

const until = <A, E, R>(read: Effect.Effect<A, E, R>, ready: (value: A) => boolean) =>
  retry(Effect.flatMap(read, (value) => (ready(value) ? Effect.succeed(value) : Effect.fail("not yet" as const))));

const messages = HobbotsRepository.use((repo) => repo.listMessages(threadId));

/** The thread's messages once `ready` holds for them and every reply has ended. */
const messagesWhen = (ready: (all: ReadonlyArray<Message>) => boolean) =>
  until(messages, (all) => all.every((m) => m.status !== "streaming" && m.status !== "stopping") && ready(all));

/** Your chat's Task tree once `ready` holds for it. */
const treeWhen = (ready: (tree: TaskTree) => boolean) =>
  retry(
    Effect.gen(function* () {
      const [tree] = yield* TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));
      return tree !== undefined && ready(tree) ? tree : yield* Effect.fail("not yet" as const);
    }),
  );

const ownedBy = (tree: TaskTree, agentId: AgentId): ReadonlyArray<Task> =>
  tree.tasks.filter((task) => task.ownerId === agentId && task.parentId !== null);

const openItems = (agentId: AgentId) => Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId }));

/** Aldric's open items of `kind` once there are `count` of them, every one in `state`. */
const itemsWhen = (kind: BackpackItem["kind"], ready: (item: BackpackItem) => boolean, count = 1) =>
  until(
    Effect.map(openItems(ALDRIC), (items) => items.filter((item) => item.kind === kind)),
    (items) => items.length === count && items.every(ready),
  );

const find = (id: BackpackItem["id"]) => Backpack.use((backpack) => backpack.find(id));

const settled = (id: BackpackItem["id"]) =>
  until(find(id), (item) => item.state === "resolved" || item.state === "failed");

/** Nothing is left in anyone's backpack. */
const nothingOpen = Effect.forEach([ALDRIC, QUILL, ADA], (agentId) =>
  until(openItems(agentId), (items) => items.length === 0),
);

/** The prompts of Aldric's continuations. */
const continuationsIn = (requests: ReadonlyArray<PromptRequest>) =>
  requests.filter((request) => request.prompt.startsWith(CONTINUATION));

/** Replies with no message of yours before them: continuations Hobbots started. */
const continuations = (all: ReadonlyArray<Message>) =>
  all.filter((m, index) => m.role === "assistant" && all[index - 1]?.role !== "user");

/** The launch, once Aldric has completed it. */
const launched = treeWhen((tree) => tree.tasks[0]?.state === "completed");

describe("the backpack end to end", () => {
  // covers IN-001, IN-004, EX-006
  it("[TC-IN-160] Quill's result that arrives after Aldric's turn ended starts one continuation, which completes the launch", async () => {
    const database = await sharedDatabase();
    const { run, requests, faults, releaseCall } = await start(database, makeFaults([{ lines: [wrapUp()] }]));
    await run(party);
    // Quill finishes only once Aldric's turn has ended.
    holdCall(faults, "copy-done");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, plan([quillDone]))));
    const ended = await run(messagesWhen((all) => all.length === 2));
    expect(ended.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    const working = await run(treeWhen((tree) => ownedBy(tree, QUILL)[0]?.state === "active"));
    expect(working.tasks[0]?.state).toBe("waiting");
    expect(continuationsIn(requests)).toEqual([]);

    await releaseCall("copy-done");
    const done = await run(launched);
    expect(done.tasks[0]?.result?.summary).toBe("The launch is ready");
    expect(ownedBy(done, QUILL).map((task) => task.state)).toEqual(["completed"]);

    // One continuation, written by Hobbots in Aldric's session, naming Quill's result.
    const all = await run(messagesWhen((each) => each.length === 3));
    expect(continuations(all)).toHaveLength(1);
    const [asked] = continuationsIn(requests);
    expect(continuationsIn(requests)).toHaveLength(1);
    // The prompt points to the briefing for the result, which tells it once (#1040).
    expect(asked?.prompt).toContain(`finished. ${RESULT_IN_BRIEFING}`);
    expect(asked?.briefing).toContain("The launch copy is ready");
    expect(asked?.sessionId).not.toBeNull();
    // Its result was consumed by the launch's completion, under the claim of its one delivery.
    const [result] = (await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Workspace" })))).filter(
      (item) => item.kind === "result",
    );
    expect(result).toBeUndefined();
    await run(nothingOpen);
  }, 20_000);

  // covers IN-005
  it("[TC-IN-161] thirty progress updates from Quill start no turn, and reach Aldric as one digest in the one continuation her result starts", async () => {
    const database = await sharedDatabase();
    const { run, requests, faults, releaseCall } = await start(database, makeFaults([{ lines: [wrapUp()] }]));
    await run(party);
    const progress = Array.from({ length: 30 }, (_, index) =>
      hub("report_checkpoint", { key: `p${index + 1}`, kind: "progress", summary: `Draft ${index + 1} written` }),
    );
    // Quill reports only once Aldric's turn has ended, and finishes once the test has looked.
    holdCall(faults, "p1");
    holdCall(faults, "copy-done");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, plan([...progress, quillDone]))));
    await run(messagesWhen((all) => all.length === 2));
    await releaseCall("p1");

    // Her thirty updates wait for Aldric, routine, with the one the hub recorded when she started,
    // and start nothing, even with his thread woken.
    const updates = await run(itemsWhen("progress", (item) => item.state === "pending" && !item.actionable, 31));
    expect(updates.filter((item) => item.dedupeKey.startsWith(`tool:${QUILL}:`))).toHaveLength(30);
    await run(ChatService.use((chat) => chat.wake(threadId)));
    await run(Effect.sleep("200 millis"));
    expect(continuationsIn(requests)).toEqual([]);
    expect(await run(messages)).toHaveLength(2);

    // Quill's result is actionable: it starts one continuation that carries the thirty as one digest.
    await releaseCall("copy-done");
    await run(launched);
    const asked = continuationsIn(requests);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain(`finished. ${RESULT_IN_BRIEFING}`);
    expect(asked[0]?.prompt).toContain("Routine progress since your last turn, 31 updates in all.");
    expect(asked[0]?.prompt).toContain("sent 31 updates. The latest: Draft 30 written");
    expect(asked[0]?.prompt).not.toContain("Draft 29 written");
    const consumed = await run(Effect.forEach(updates, (item) => settled(item.id)));
    expect(consumed.every((item) => item.disposition?._tag === "consumed")).toBe(true);
    await run(Effect.sleep("200 millis"));
    expect(continuationsIn(requests)).toHaveLength(1);
    await run(nothingOpen);
  }, 20_000);

  // covers EX-006, IN-001, EX-003
  it("[TC-IN-162] Hobbots stopping between Quill finishing and Aldric hearing of it loses nothing: the next start continues him once", async () => {
    const database = await sharedDatabase();
    const first = await start(database);
    await first.run(party);
    holdCall(first.faults, "copy-done");
    await first.run(ChatService.use((chat) => chat.sendPrompt(threadId, plan([quillDone]))));
    await first.run(messagesWhen((all) => all.length === 2));

    // Quill finishes, and the hub stops right after her result commits, before Aldric hears of it.
    first.faults.crashBeforeNotify = true;
    await first.releaseCall("copy-done");
    const [result] = await first.run(itemsWhen("result", (item) => item.state === "pending"));
    if (result === undefined) throw new Error("no result recorded");
    expect(result.deliveries).toEqual([]);
    const finished = await first.run(treeWhen((tree) => ownedBy(tree, QUILL)[0]?.state === "completed"));
    expect(finished.tasks[0]?.state).not.toBe("completed");
    expect(continuationsIn(first.requests)).toEqual([]);

    // The next start finds the result waiting, and Aldric's continuation completes the launch.
    const second = await start(database, makeFaults([{ lines: [wrapUp()] }]));
    const done = await second.run(launched);
    expect(done.tasks[0]?.result?.summary).toBe("The launch is ready");
    // Nothing ran twice: one Task and one Attempt for Quill, one delivery of her result, one continuation.
    expect(ownedBy(done, QUILL)).toHaveLength(1);
    expect(done.attempts.filter((each) => each.agentId === QUILL)).toHaveLength(1);
    const consumed = await second.run(settled(result.id));
    expect(consumed.disposition?._tag).toBe("consumed");
    expect(consumed.deliveries).toHaveLength(1);
    expect(continuationsIn(second.requests)).toHaveLength(1);
    expect(second.requests.filter((request) => request.prompt.startsWith("Draft the launch copy"))).toEqual([]);
    const all = await second.run(messagesWhen((each) => each.length === 3));
    expect(continuations(all)).toHaveLength(1);
    await second.run(nothingOpen);
  }, 20_000);

  // covers IN-003
  it("[TC-IN-163] a continuation cut off after it brought Ada in is delivered again, and the redelivery makes no second Task or effect", async () => {
    const database = await sharedDatabase();
    const bringInAda = hub("delegate_task", {
      key: "review",
      hob: "Ada",
      brief: [
        "Review the launch copy",
        hub("complete_task", { delivered: true, key: "review-done", summary: "The copy reads well" }),
      ].join("\n"),
    });
    const { run, requests } = await start(
      database,
      makeFaults([
        // Quill's result: Aldric brings Ada in, and the provider cuts his turn off before it ends.
        { cut: true, lines: [bringInAda] },
        // Delivered again, he makes the same call with the same key, and waits for Ada.
        { lines: [bringInAda, hub("wait_for", { key: "wait-review", tasks: ["$review.task_id"] })] },
        // Ada's result: he wraps up.
        { lines: [wrapUp()] },
      ]),
    );
    await run(party);
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, plan([quillDone]))));

    const done = await run(launched);
    // One Task, one delegation and one session for Ada, though she was brought in on two deliveries.
    const reviews = ownedBy(done, ADA);
    expect(reviews).toHaveLength(1);
    expect(done.delegations.filter((each) => each.memberId === ADA)).toHaveLength(1);
    expect(done.attempts.filter((each) => each.agentId === ADA)).toHaveLength(1);
    expect(requests.filter((request) => request.prompt.startsWith("Review the launch copy"))).toHaveLength(1);

    // Quill's result was delivered twice and consumed once, by the turn that ran to its end.
    const all = await run(messagesWhen((each) => continuations(each).length === 3));
    expect(continuations(all).map((m) => m.status)).toEqual(["interrupted", "complete", "complete"]);
    const [cut, redelivered] = continuationsIn(requests);
    // The cut-off turn's session was told the result, so its redelivery points back to it (#1040).
    expect(cut?.briefing).toContain("The launch copy is ready");
    expect(redelivered?.prompt).toContain(`finished. ${RESULT_IN_BRIEFING}`);
    const results = (await run(TaskRepository.use((tasks) => tasks.readThreadTrees(threadId))))[0];
    const quillTask = results === undefined ? undefined : ownedBy(results, QUILL)[0];
    const quillResult = (await run(Backpack.use((backpack) => backpack.listOpen({ _tag: "Workspace" })))).find(
      (item) => item.taskId === quillTask?.id && item.kind === "result",
    );
    expect(quillResult).toBeUndefined();
    // Both calls answered with the same Task: the second found the first's result.
    expect(continuations(all)[1]?.content).toContain(reviews[0]?.id ?? "no Task");
    expect(continuations(all)[0]?.content ?? "").not.toContain("delegate_task:");
    expect(continuationsIn(requests)).toHaveLength(3);
    await run(nothingOpen);
  }, 20_000);

  // covers IN-002, IN-003
  it("[TC-IN-164] a claim whose lease runs out while Aldric's turn stalls is expired with a new fencing token, and the item is reclaimed and consumed once", async () => {
    const database = await sharedDatabase();
    const faults = makeFaults([
      // The first continuation stalls before the runtime starts it, and its claim stops renewing.
      { stall: true, lines: [wrapUp()] },
      { lines: [wrapUp("wrap-again")] },
    ]);
    const { run, requests, releaseCall, unstall } = await start(database, faults, { ...LIMITS, lease: SHORT_LEASE });
    await run(party);
    holdCall(faults, "copy-done");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, plan([quillDone]))));
    await run(messagesWhen((all) => all.length === 2));
    faults.freezeRenewals = true;
    await releaseCall("copy-done");

    // Aldric's continuation claims Quill's result, then stalls; its lease runs out and is expired.
    const [claimed] = await run(itemsWhen("result", (item) => item.state === "delivered" && item.claim !== null));
    const first = claimed?.claim;
    if (claimed === undefined || first === null || first === undefined) throw new Error("no claim held");
    // Every item the turn carried is expired before it goes on, Quill's "started" update with the
    // result, so the next continuation can claim them all.
    const carried = await run(
      until(
        openItems(ALDRIC),
        (items) =>
          items.every((item) => item.claim === null) &&
          items.some((item) => item.id === claimed.id && item.fencingToken > first.token),
      ),
    );
    const expired = carried.find((item) => item.id === claimed.id);
    expect(expired?.state).toBe("pending");
    faults.freezeRenewals = false;
    // The stalled worker can no longer renew or apply anything under its claim.
    const refused = await run(Effect.flip(Backpack.use((backpack) => backpack.renew(claimed.id, first, "1 minute"))));
    expect(refused._tag).toBe("StaleBackpackClaim");

    // The stalled turn goes on, and its runtime accepts it with the claim gone: it stops there,
    // spending nothing more, and makes no call (#375). The item is claimed again and consumed once.
    await unstall();
    const done = await run(launched);
    expect(done.tasks[0]?.result?.summary).toBe("The launch is ready");
    const consumed = await run(settled(claimed.id));
    expect(consumed.disposition?._tag).toBe("consumed");
    expect(consumed.fencingToken).toBeGreaterThan(expired?.fencingToken ?? Number.POSITIVE_INFINITY);
    expect(consumed.deliveries).toHaveLength(2);
    expect(continuationsIn(requests)).toHaveLength(2);
    // Only the second continuation's completion landed; the stale one was stopped before it called anything.
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    const [stopped, landed] = continuations(all).map(({ status, content }) => ({ status, content }));
    expect(landed).toMatchObject({ status: "complete", content: expect.stringContaining("complete_task: ") });
    expect(stopped?.status).not.toBe("complete");
    expect(stopped?.content).not.toContain("complete_task:");
    await run(nothingOpen);
  }, 20_000);

  // covers IN-002, IN-003, OR-001
  it("[TC-IN-167] a claim that runs out while Aldric's accepted turn is mid-call fences the call: his late delegation brings nobody in", async () => {
    const database = await sharedDatabase();
    const lateReview = hub("delegate_task", { key: "late-review", hob: "Ada", brief: "Review the launch copy" });
    const faults = makeFaults([
      // The first continuation is accepted, then its delegation is held while its claim runs out.
      { lines: [lateReview, wrapUp()] },
      { lines: [wrapUp("wrap-again")] },
    ]);
    const { run, requests, releaseCall } = await start(database, faults, { ...LIMITS, lease: SHORT_LEASE });
    await run(party);
    holdCall(faults, "copy-done");
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, plan([quillDone]))));
    await run(messagesWhen((all) => all.length === 2));
    holdCall(faults, "late-review");
    faults.freezeRenewals = true;
    await releaseCall("copy-done");

    const [claimed] = await run(itemsWhen("result", (item) => item.state === "processing" && item.claim !== null));
    const first = claimed?.claim;
    if (claimed === undefined || first === null || first === undefined) throw new Error("no claim held");
    await run(
      until(openItems(ALDRIC), (items) =>
        items.some((item) => item.id === claimed.id && item.claim === null && item.fencingToken > first.token),
      ),
    );
    faults.freezeRenewals = false;

    // The held call goes on under the lost claim: it writes nothing, and so does the completion after it.
    const before = await run(treeWhen(() => true));
    await releaseCall("late-review");
    const done = await run(launched);
    expect(ownedBy(done, ADA)).toHaveLength(0);
    expect(done.delegations.filter((each) => each.memberId === ADA)).toHaveLength(0);
    expect(done.attempts.filter((each) => each.agentId === ADA)).toHaveLength(0);
    expect(done.tasks).toHaveLength(before.tasks.length);
    expect(requests.some((request) => request.prompt.startsWith("Review the launch copy"))).toBe(false);
    const all = await run(messagesWhen((each) => continuations(each).length === 2));
    expect(continuations(all)[0]?.content).toContain("delegate_task: Refused (claim-stale)");
    expect(continuations(all)[0]?.content).toContain("complete_task: Refused (claim-stale)");
    expect(continuations(all)[1]?.content).toContain("complete_task: ");
    const consumed = await run(settled(claimed.id));
    expect(consumed.disposition?._tag).toBe("consumed");
    expect(consumed.deliveries).toHaveLength(2);
    await run(nothingOpen);
  }, 20_000);

  // covers IN-007, EX-004
  it("[TC-IN-165] Quill's result whose every continuation is cut off becomes a blocker with a next action, and Retry completes the launch", async () => {
    const database = await sharedDatabase();
    const faults = makeFaults([{ cut: true }, { cut: true }, { cut: true }]);
    const { run, requests } = await start(database, faults);
    await run(party);
    await run(ChatService.use((chat) => chat.sendPrompt(threadId, plan([quillDone]))));

    // Three deliveries, each cut off: the result fails as a blocker instead of disappearing.
    const quill = await run(treeWhen((tree) => ownedBy(tree, QUILL)[0]?.state === "completed"));
    const [result] = await run(
      until(
        Backpack.use((backpack) => backpack.listBlocked({ _tag: "Workspace" })),
        (items) => items.length === 1,
      ),
    );
    if (result === undefined) throw new Error("no result recorded");
    expect(result).toMatchObject({ kind: "result", recipientId: ALDRIC, state: "failed" });
    expect(result.deliveries).toHaveLength(3);
    expect(result.blockers).toMatchObject([
      { number: 1, reason: "retries-exhausted", nextAction: "retry", lastEnd: "interrupted", afterDeliveries: 3 },
    ]);
    // Quill's work is kept, and no more turns start on their own.
    expect(ownedBy(quill, QUILL)[0]?.result?.summary).toBe("The launch copy is ready");
    await run(Effect.sleep("200 millis"));
    expect(continuationsIn(requests)).toHaveLength(3);
    const tree = await run(treeWhen(() => true));
    expect(tree.tasks[0]?.state).not.toBe("completed");

    // You choose Retry: the result is delivered again, and Aldric completes the launch.
    faults.scripts.push({ lines: [wrapUp()] });
    await run(decideBlocker(result.id, 1, "retry").pipe(Effect.provide(BlockersHostLive)));
    const done = await run(launched);
    expect(done.tasks[0]?.result?.summary).toBe("The launch is ready");
    const consumed = await run(settled(result.id));
    expect(consumed.disposition?._tag).toBe("consumed");
    expect(consumed.blockers).toMatchObject([{ decision: "retry" }]);
    const all = await run(messagesWhen((each) => continuations(each).length === 4));
    expect(continuations(all).map((m) => m.status)).toEqual(["interrupted", "interrupted", "interrupted", "complete"]);
    await run(nothingOpen);
  }, 20_000);
});
