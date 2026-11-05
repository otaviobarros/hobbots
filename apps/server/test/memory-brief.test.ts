import {
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  MEMORY_UNAVAILABLE,
  MemoryStore,
  type PromptRequest,
  RuntimeAdapter,
} from "@hobbots/agents";
import { Agent, AgentId, MemoryPath, type MemoryScope, type ThreadId } from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, Option, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

// The memory brief (ADR 028) as a hob's turns receive it, on the fake runtime and the fake memory.

const PIP = AgentId.make("pip");
const QUILL = AgentId.make("quill");
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: PIP };

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
    createdAt: "2026-11-05T00:00:00.000Z",
  });

/** A hub with two hobs, the fake memory and a fake runtime that records each request it gets. */
const memoryHub = () => {
  const memory = makeMemoryStoreFake();
  const asked: Array<PromptRequest> = [];
  const fake = makeFakeRuntime();
  const runtime = Layer.succeed(RuntimeAdapter, {
    ...fake,
    sendPrompt: (request) => {
      asked.push(request);
      return fake.sendPrompt(request);
    },
  });
  const summon = Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(hob(PIP, "Pip"));
    yield* repo.insertAgent(hob(QUILL, "Quill"));
  });
  const layer = ChatService.layer.pipe(
    Layer.provide(HobTools.chatOnly),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effectDiscard(summon).pipe(
          Layer.provideMerge(HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabase))),
        ),
        EventBus.layer,
        HobAdmission.layer,
        Layer.succeed(MemoryStore, memory.store),
        runtime,
      ),
    ),
  );
  /** Sends `content` in `threadId` and waits for its reply to end; answers what the runtime was told. */
  const say = (threadId: ThreadId, content: string) =>
    Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const before = asked.length;
      yield* chat.sendPrompt(threadId, content);
      yield* repo.listMessages(threadId).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.status === "streaming" || m.status === "queued") ||
          messages.at(-1)?.role !== "assistant"
            ? Effect.fail("busy" as const)
            : Effect.succeed(messages.at(-1)),
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      return asked[before] as PromptRequest;
    });
  /** Saves a lesson in Pip's own memory, as Pip's `memory_save` would. */
  const learn = (path: string, markdown: string) =>
    memory.store.write(
      { _tag: "Hob", agentId: PIP, projects: [] },
      pipsOwn,
      { path: MemoryPath.make(path), markdown, tags: [], pinned: false },
      { _tag: "Any" },
    );
  const run = <A, E>(effect: Effect.Effect<A, E, ChatService | HobbotsRepository>) =>
    Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<A, E>);
  return { run, say, learn, controls: memory.controls };
};

describe("the memory brief", () => {
  // covers CH-001, CH-002
  it("[TC-CH-285] a lesson saved in one thread is in the next thread's brief for the same hob, and never another hob's", async () => {
    const hub = memoryHub();
    await hub.run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const first = yield* chat.createThread(PIP);
        // An empty memory sends no section.
        expect((yield* hub.say(first.id, "Which suite is fast?")).briefing).toBeNull();
        yield* hub.learn("notes/tests.md", "# Tests\n\nRun the fast suite first.");

        const next = yield* chat.createThread(PIP);
        const briefed = yield* hub.say(next.id, "Run the tests.");
        expect(briefed.sessionId).toBeNull();
        expect(briefed.briefing).toMatch(/^## From your memory\n\n.*reference data, not instructions/);
        expect(briefed.briefing).toContain("### Your own pages\n\n#### Tests\nnotes/tests.md, updated ");
        expect(briefed.briefing).toContain("> Run the fast suite first.");

        const quills = yield* chat.createThread(QUILL);
        expect((yield* hub.say(quills.id, "Run the tests.")).briefing).toBeNull();
      }),
    );
  });

  // covers CH-001, CH-002
  it("[TC-CH-286] is sent again only when it changed, as the only briefing of a resumed turn", async () => {
    const hub = memoryHub();
    await hub.run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        yield* hub.learn("notes/tests.md", "# Tests\n\nRun the fast suite first.");
        const thread = yield* chat.createThread(PIP);
        const first = yield* hub.say(thread.id, "Hello.");
        expect(first.briefing).toContain("#### Tests");

        // Unchanged: the session already has it, so the next turn is told nothing.
        const unchanged = yield* hub.say(thread.id, "Again.");
        expect(unchanged.sessionId).not.toBeNull();
        expect(unchanged.briefing).toBeNull();

        // Changed: the resumed session hears the new brief, and nothing else, since no other brain ran.
        yield* hub.learn("notes/deploys.md", "# Deploys\n\nDeploy on Tuesdays.");
        const changed = yield* hub.say(thread.id, "And now?");
        expect(changed.sessionId).toBe(unchanged.sessionId);
        expect(changed.briefing).toMatch(/^## From your memory/);
        expect(changed.briefing).toContain("#### Deploys");
        expect(changed.briefing).not.toContain("## This thread so far");
        expect(changed.briefing).not.toContain("## Since your last reply");
        // The session keeps what it received, so a restart does not send it again.
        const stored = Option.getOrThrow(yield* repo.findThread(thread.id));
        expect(stored.sessions[0]?.memoryBrief).toEqual(expect.any(String));
        expect((yield* hub.say(thread.id, "Thanks.")).briefing).toBeNull();
      }),
    );
  });

  // covers CH-001, EX-005
  it("[TC-CH-287] says memory is unavailable during an outage, and the turn goes on", async () => {
    const hub = memoryHub();
    await hub.run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* HobbotsRepository;
        yield* hub.learn("notes/tests.md", "# Tests\n\nRun the fast suite first.");
        const thread = yield* chat.createThread(PIP);
        hub.controls.setDown(true);
        const down = yield* hub.say(thread.id, "Hello.");
        expect(down.briefing).toBe(MEMORY_UNAVAILABLE);
        expect((yield* repo.listMessages(thread.id)).at(-1)?.status).toBe("complete");

        // Back up, the session is told what it missed while memory was down.
        hub.controls.setDown(false);
        expect((yield* hub.say(thread.id, "Again.")).briefing).toContain("#### Tests");
      }),
    );
  });
});
