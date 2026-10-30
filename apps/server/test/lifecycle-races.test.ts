import { Agent, AgentId, type HobbotsEvent } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { HobAdmission } from "../src/admission.ts";
import { ChatService } from "../src/chat.ts";
import { EventBus } from "../src/event-bus.ts";
import { HobService } from "../src/hobs.ts";
import { HobLifecycle } from "../src/lifecycle.ts";

// Each case holds one request at a chosen repository call and releases it only after a second
// request has asked for the same hob, so the overlap happens on every run. The short pause after
// that request arrives gives an unguarded implementation room to act on what it read.

const HOB_ID = AgentId.make("wren");
type Gated = "upsertMessage" | "setAgentStatus" | "updateAgentConfig";

/** Holds the next call to one repository method until the test releases it. */
const makeGate = Effect.gen(function* () {
  const reached = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let armed: Gated | undefined;
  let entering: Deferred.Deferred<void> | undefined;
  return {
    /** Resolves once the next request has asked for the hob's admission (and is waiting on it). */
    nextAdmission: Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      entering = entered;
      return Deferred.await(entered).pipe(Effect.andThen(Effect.sleep("20 millis")));
    }),
    admitting: Effect.suspend(() => {
      const entered = entering;
      entering = undefined;
      return entered === undefined ? Effect.void : Deferred.succeed(entered, undefined);
    }),
    arm: (method: Gated) => {
      armed = method;
    },
    reached: Deferred.await(reached),
    release: Deferred.succeed(release, undefined),
    pass: (method: Gated) =>
      Effect.suspend(() => {
        if (armed !== method) return Effect.void;
        armed = undefined;
        return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)));
      }),
  };
});
type Gate = Effect.Success<typeof makeGate>;

const run = <A, E>(test: (gate: Gate, events: Array<HobbotsEvent>) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const gate = yield* makeGate;
    const events: Array<HobbotsEvent> = [];
    const repository = Layer.effect(
      HobbotsRepository,
      Effect.gen(function* () {
        const base = yield* HobbotsRepository;
        return HobbotsRepository.of({
          ...base,
          upsertMessage: (message) => gate.pass("upsertMessage").pipe(Effect.andThen(base.upsertMessage(message))),
          setAgentStatus: (next, from) =>
            gate.pass("setAgentStatus").pipe(Effect.andThen(base.setAgentStatus(next, from))),
          updateAgentConfig: (agent) =>
            gate.pass("updateAgentConfig").pipe(Effect.andThen(base.updateAgentConfig(agent))),
        });
      }),
    ).pipe(Layer.provide(HobbotsRepository.layer), Layer.provide(TestDatabase));
    const bus = Layer.succeed(EventBus, {
      publish: (event) => Effect.sync(() => void events.push(event)),
      stream: Stream.empty,
    });
    const admission = Layer.effect(
      HobAdmission,
      Effect.gen(function* () {
        const base = yield* HobAdmission;
        return HobAdmission.of({
          withHob: (id, effect) => gate.admitting.pipe(Effect.andThen(base.withHob(id, effect))),
        });
      }),
    ).pipe(Layer.provide(HobAdmission.layer));
    const App = HobLifecycle.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(ChatService.layer, HobService.layer)),
      Layer.provideMerge(Layer.mergeAll(repository, bus, admission, FakeRuntimeLayer({ delay: "40 millis" }))),
    );
    return yield* Effect.gen(function* () {
      yield* (yield* HobbotsRepository).insertAgent(
        new Agent({
          id: HOB_ID,
          name: "Wren",
          craft: "Scribe",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 7,
          lookColor: "moss",
          configVersion: 1,
          createdAt: "2026-10-30T00:00:00.000Z",
        }),
      );
      return yield* test(gate, events);
    }).pipe(Effect.provide(App));
  }).pipe(Effect.scoped, Effect.runPromise);
type Services = HobbotsRepository | ChatService | HobService | HobLifecycle;

const status = HobbotsRepository.use((repo) => repo.findAgent(HOB_ID)).pipe(
  Effect.map((agent) => Option.getOrThrow(agent).status),
);

describe("lifecycle changes that overlap other requests", () => {
  // covers AG-006, CH-004
  it("[TC-AG-037] stops a reply that was being admitted when retirement with stop arrived", async () => {
    const result = await run((gate) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const thread = yield* chat.createThread(HOB_ID);

        gate.arm("upsertMessage");
        const send = yield* Effect.forkChild(chat.sendPrompt(thread.id, "hello"));
        yield* gate.reached;
        const queued = yield* gate.nextAdmission;
        const retire = yield* Effect.forkChild((yield* HobLifecycle).retire(HOB_ID, "stop"));
        yield* queued;
        // The retirement waits for the admission in progress.
        const statusWhileAdmitting = yield* status;
        yield* gate.release;
        const sent = yield* Fiber.join(send);
        yield* Fiber.join(retire);
        return {
          statusWhileAdmitting,
          sent: sent.assistantMessage.id,
          messages: yield* repo.listMessages(thread.id),
          running: yield* chat.activeThreads,
          status: yield* status,
        };
      }),
    );

    expect(result.statusWhileAdmitting).toBe("active");
    expect(result.messages.find((m) => m.id === result.sent)?.status).toBe("interrupted");
    expect(result.running).toEqual([]);
    expect(result.status).toBe("retired");
  });

  // covers AG-006
  it("[TC-AG-038] refuses a message that arrives while the hob is being retired", async () => {
    const result = await run((gate) =>
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        const thread = yield* chat.createThread(HOB_ID);

        gate.arm("setAgentStatus");
        const retire = yield* Effect.forkChild((yield* HobLifecycle).retire(HOB_ID, "stop"));
        yield* gate.reached;
        const sendQueued = yield* gate.nextAdmission;
        const send = yield* Effect.forkChild(chat.sendPrompt(thread.id, "hello"));
        yield* sendQueued;
        const threadQueued = yield* gate.nextAdmission;
        const newThread = yield* Effect.forkChild(chat.createThread(HOB_ID));
        yield* threadQueued;
        yield* gate.release;
        yield* Fiber.join(retire);
        return {
          send: yield* Fiber.await(send),
          newThread: yield* Fiber.await(newThread),
          messages: yield* repo.listMessages(thread.id),
          threads: yield* repo.listThreads(HOB_ID),
        };
      }),
    );

    const refusal = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
      Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
    for (const exit of [refusal(result.send), refusal(result.newThread)]) {
      expect(exit).toEqual(Option.some(expect.objectContaining({ _tag: "HobUnavailable", status: "retired" })));
    }
    expect(result.messages).toEqual([]);
    expect(result.threads).toHaveLength(1);
  });

  // covers AG-006
  it("[TC-AG-039] keeps a hob retired when a wake read it as paused before the retirement", async () => {
    const result = await run((gate) =>
      Effect.gen(function* () {
        const lifecycle = yield* HobLifecycle;
        yield* lifecycle.pause(HOB_ID);

        gate.arm("setAgentStatus");
        const wake = yield* Effect.forkChild(lifecycle.wake(HOB_ID));
        yield* gate.reached;
        const queued = yield* gate.nextAdmission;
        const retire = yield* Effect.forkChild(lifecycle.retire(HOB_ID, "finish"));
        yield* queued;
        yield* gate.release;
        // Whether the wake lands before the retirement or is refused after it, it cannot undo it.
        yield* Fiber.await(wake);
        yield* Fiber.join(retire);
        return {
          status: yield* status,
          // A later wake is refused.
          wakeAgain: yield* Effect.exit(lifecycle.wake(HOB_ID)),
        };
      }),
    );

    expect(result.status).toBe("retired");
    expect(Exit.isFailure(result.wakeAgain)).toBe(true);
  });

  // covers AG-006, AG-002
  it("[TC-AG-040] announces the retirement after an edit that overlapped it, so the hob stays archived", async () => {
    const result = await run((gate, events) =>
      Effect.gen(function* () {
        gate.arm("updateAgentConfig");
        const edit = yield* Effect.forkChild((yield* HobService).update(HOB_ID, { instructions: "Be brief." }));
        yield* gate.reached;
        const queued = yield* gate.nextAdmission;
        const retire = yield* Effect.forkChild((yield* HobLifecycle).retire(HOB_ID, "finish"));
        yield* queued;
        yield* gate.release;
        yield* Fiber.join(edit);
        yield* Fiber.join(retire);
        return {
          announced: events.flatMap((event) =>
            event._tag === "AgentUpserted" ? [[event.agent.configVersion, event.agent.status]] : [],
          ),
          stored: Option.getOrThrow(yield* HobbotsRepository.use((repo) => repo.findAgent(HOB_ID))),
        };
      }),
    );

    expect(result.announced).toEqual([
      [2, "active"],
      [2, "retired"],
    ]);
    expect(result.stored).toMatchObject({ configVersion: 2, instructions: "Be brief.", status: "retired" });
  });
});
