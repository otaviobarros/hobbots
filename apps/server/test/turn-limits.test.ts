import {
  AdditionalRuntimes,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobTools,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  TurnSlots,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  DEFAULT_TURN_LIMITS,
  type RuntimeKind,
  Thread,
  ThreadId,
  type TurnLimits,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, TurnLimitsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeAdditionalRuntimesLayer, FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Layer, ManagedRuntime, Schedule, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

// Issue #1448 (OR-005): chat turns past a limit per hob or per runtime wait, queued, and start once
// a slot frees, on Claude Code and Codex alike; the limits hold across a restart. Every runtime turn
// is held on a gate until the test lets it finish, and the test waits on what the hub reports,
// never on a fixed delay (STD-TEST-009).

const at = "2026-01-01T00:00:00.000Z";

/** A turn the runtime was asked for: on which runtime, and its prompt. */
interface Start {
  readonly runtime: RuntimeKind;
  readonly prompt: string;
  readonly gate: Deferred.Deferred<void>;
}

/** Every turn either runtime is asked for, each held until its gate opens. */
const gatedAdapter = (starts: Array<Start>, runtime: RuntimeKind, fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request: PromptRequest) => {
    const gate = Deferred.makeUnsafe<void>();
    starts.push({ runtime, prompt: request.prompt, gate });
    return Stream.unwrap(Effect.as(Deferred.await(gate), fake.sendPrompt(request)));
  },
});

const gatedRuntimes = (starts: Array<Start>) =>
  Layer.mergeAll(
    Layer.effect(
      RuntimeAdapter,
      RuntimeAdapter.use((fake) => Effect.succeed(gatedAdapter(starts, "claude-code", fake))),
    ).pipe(Layer.provide(FakeRuntimeLayer())),
    Layer.effect(
      AdditionalRuntimes,
      AdditionalRuntimes.use((others) =>
        Effect.sync(() => {
          const codex = others.get("codex");
          if (codex === undefined) throw new Error("no fake Codex");
          return new Map([["codex" as const, gatedAdapter(starts, "codex", codex)]]);
        }),
      ),
    ).pipe(Layer.provide(FakeAdditionalRuntimesLayer())),
  );

type Database = Layer.Layer<Layer.Success<typeof TestDatabase>>;

/** One life of the hub over `database`: its chat and its turn slots, with the limits it keeps. */
const hubLayer = (database: Database, starts: Array<Start>) =>
  HobLifecycle.layer.pipe(
    Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly))),
    Layer.provideMerge(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        EventBus.layer,
        HobAdmission.layer,
        TurnSlots.layer.pipe(Layer.provide(TurnLimitsRepositoryLive)),
        gatedRuntimes(starts),
      ),
    ),
    Layer.provideMerge(database),
  );

type HubServices = Layer.Success<ReturnType<typeof hubLayer>>;
type Hub = ManagedRuntime.ManagedRuntime<HubServices, never>;

const hob = (id: string, runtime: RuntimeKind) =>
  new Agent({
    id: AgentId.make(id),
    name: id,
    roleTitle: "Helper",
    runtime,
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: at,
  });

/** A database with each hob and one thread per name, `<hob>-<n>`. */
const openDatabase = async (
  scope: Scope.Closeable,
  threads: ReadonlyArray<{ readonly hob: string; readonly runtime: RuntimeKind; readonly ids: ReadonlyArray<string> }>,
): Promise<Database> => {
  const database = Layer.succeedContext(await Effect.runPromise(Layer.buildWithScope(TestDatabase, scope)));
  const seed = Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const each of threads) {
      yield* repo.insertAgent(hob(each.hob, each.runtime));
      for (const id of each.ids) {
        yield* repo.upsertThread(
          new Thread({
            id: ThreadId.make(id),
            agentId: AgentId.make(each.hob),
            title: id,
            createdAt: at,
            updatedAt: at,
          }),
        );
      }
    }
  });
  await Effect.runPromise(Effect.provide(seed, HobbotsRepositoryLive.pipe(Layer.provideMerge(database))));
  return database;
};

let scopes: Array<Scope.Closeable> = [];
let hubs: Array<Hub> = [];
afterEach(async () => {
  for (const hub of hubs) await hub.dispose();
  for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Effect.void as never));
  scopes = [];
  hubs = [];
});

/** A hub over a new database, and what it is asked to run. */
const start = async (threads: Parameters<typeof openDatabase>[1], limits: TurnLimits) => {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const database = await openDatabase(scope, threads);
  const starts: Array<Start> = [];
  const open = () => {
    const hub = ManagedRuntime.make(hubLayer(database, starts));
    hubs.push(hub);
    return hub;
  };
  const hub = open();
  await hub.runPromise(TurnSlots.use((slots) => slots.setLimits(limits)));
  return { hub, starts, open };
};

const send = (hub: Hub, threadId: string, text: string) =>
  hub.runPromise(ChatService.use((chat) => chat.sendPrompt(ThreadId.make(threadId), text)));

/** Waits until `check` holds, reading again every millisecond: never a fixed delay. */
const until = <A>(hub: Hub, read: Effect.Effect<A, never, HubServices>, check: (value: A) => boolean) =>
  hub.runPromise(
    read.pipe(
      Effect.flatMap((value) => (check(value) ? Effect.succeed(value) : Effect.fail("not yet" as const))),
      Effect.retry({ schedule: Schedule.spaced("1 millis"), times: 5000 }),
    ),
  );

const report = (hub: Hub) => hub.runPromise(TurnSlots.use((slots) => slots.report));
const statusOf = async (hub: Hub, threadId: string) =>
  (await hub.runPromise(HobbotsRepository.use((repo) => repo.listMessages(ThreadId.make(threadId))))).map(
    (m) => `${m.role}:${m.status}`,
  );
const startedCount = (starts: ReadonlyArray<Start>, count: number) => Effect.sync(() => starts.length >= count);
const finish = (start: Start | undefined) =>
  Effect.runPromise(Deferred.succeed(start?.gate as Deferred.Deferred<void>, undefined));

describe("turn limits in chat", () => {
  // covers OR-005
  it("[TC-CH-1448-01] keeps a message queued while its hob runs as many turns as allowed, then starts it", async () => {
    const { hub, starts } = await start([{ hob: "aldric", runtime: "claude-code", ids: ["a-1", "a-2"] }], {
      ...DEFAULT_TURN_LIMITS,
      perHob: 1,
    });
    await send(hub, "a-1", "first");
    await until(hub, startedCount(starts, 1), (ok) => ok);
    const second = await send(hub, "a-2", "second");
    expect(second.assistantMessage).toBe(null);
    expect(await statusOf(hub, "a-2")).toEqual(["user:queued"]);
    const waiting = await report(hub);
    expect(waiting.active.map((each) => each.id)).toEqual(["thread:a-1"]);
    expect(waiting.waiting.map((each) => [each.id, each.waitingOn])).toEqual([["thread:a-2", "hob"]]);
    expect(starts.map((each) => each.prompt)).toEqual(["first"]);

    // The first turn ends: its slot goes to the message that waited.
    await finish(starts[0]);
    await until(hub, startedCount(starts, 2), (ok) => ok);
    expect(starts.map((each) => each.prompt)).toEqual(["first", "second"]);
    const now = await until(
      hub,
      TurnSlots.use((slots) => slots.report),
      (r) => r.waiting.length === 0 && r.active.length === 1,
    );
    expect(now.active.map((each) => each.id)).toEqual(["thread:a-2"]);
    await finish(starts[1]);
    await until(
      hub,
      TurnSlots.use((slots) => slots.report),
      (r) => r.active.length === 0,
    );
    expect(await statusOf(hub, "a-2")).toEqual(["user:complete", "assistant:complete"]);
  });

  // covers OR-005
  it("[TC-CH-1448-02] limits each runtime on its own, Claude Code and Codex alike", async () => {
    const { hub, starts } = await start(
      [
        { hob: "aldric", runtime: "claude-code", ids: ["a-1"] },
        { hob: "bram", runtime: "claude-code", ids: ["b-1"] },
        { hob: "cora", runtime: "codex", ids: ["c-1"] },
        { hob: "dain", runtime: "codex", ids: ["d-1"] },
      ],
      { ...DEFAULT_TURN_LIMITS, perRuntime: { "claude-code": 1, codex: 1 } },
    );
    await send(hub, "a-1", "aldric");
    await send(hub, "c-1", "cora");
    await until(hub, startedCount(starts, 2), (ok) => ok);
    await send(hub, "b-1", "bram");
    await send(hub, "d-1", "dain");
    const full = await report(hub);
    expect(full.active.map((each) => [each.id, each.runtime])).toEqual([
      ["thread:a-1", "claude-code"],
      ["thread:c-1", "codex"],
    ]);
    expect(full.waiting.map((each) => [each.id, each.waitingOn])).toEqual([
      ["thread:b-1", "runtime"],
      ["thread:d-1", "runtime"],
    ]);
    // Each runtime's slot goes to the turn waiting on that runtime.
    await finish(starts.find((each) => each.prompt === "cora"));
    await until(hub, startedCount(starts, 3), (ok) => ok);
    expect(starts.map((each) => [each.runtime, each.prompt])).toEqual([
      ["claude-code", "aldric"],
      ["codex", "cora"],
      ["codex", "dain"],
    ]);
    await finish(starts.find((each) => each.prompt === "aldric"));
    await until(hub, startedCount(starts, 4), (ok) => ok);
    expect(starts.at(-1)).toMatchObject({ runtime: "claude-code", prompt: "bram" });
    for (const each of starts.slice(2)) await finish(each);
    await until(
      hub,
      TurnSlots.use((slots) => slots.report),
      (r) => r.active.length === 0 && r.waiting.length === 0,
    );
  });

  // covers OR-005
  it("[TC-CH-1448-03] keeps the limits and the waiting message across a restart, and starts it then", async () => {
    const { hub, starts, open } = await start([{ hob: "aldric", runtime: "claude-code", ids: ["a-1", "a-2"] }], {
      ...DEFAULT_TURN_LIMITS,
      perHob: 1,
    });
    await send(hub, "a-1", "first");
    await until(hub, startedCount(starts, 1), (ok) => ok);
    await send(hub, "a-2", "second");
    expect(await statusOf(hub, "a-2")).toEqual(["user:queued"]);

    // The hub stops while the first turn runs and the second waits.
    await hub.dispose();
    hubs = hubs.filter((each) => each !== hub);
    const again = open();
    // The message that waited starts at boot, in the slot the stopped turn no longer holds.
    await until(again, startedCount(starts, 2), (ok) => ok);
    expect(starts.map((each) => each.prompt)).toEqual(["first", "second"]);
    const after = await report(again);
    expect(after.limits).toEqual({ ...DEFAULT_TURN_LIMITS, perHob: 1 });
    expect(after.active.map((each) => each.id)).toEqual(["thread:a-2"]);
    await finish(starts[1]);
    await until(
      again,
      TurnSlots.use((slots) => slots.report),
      (r) => r.active.length === 0,
    );
  });
});
