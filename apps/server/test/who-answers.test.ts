import { ChatService, HobAdmission, HobbotsRepository, HobTools, ThreadMemberRepository } from "@hobbots/agents";
import { Agent, AgentId, hobActor, OWNER_ACTOR } from "@hobbots/domain";
import { HobbotsRepositoryLive, ThreadMemberRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

// Issue #1460 (ADR 039, Who answers): a message you send is answered by the hobs `answerersFor`
// names, decided from the thread's members before the message is stored. A camp with several hobs
// and no mention starts no turn.

const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: `You are ${name}.`,
    lookSeed: 4821,
    lookColor: "violet",
    configVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

const summonHobs = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(hob(QUILL, "Quill"));
  yield* repo.insertAgent(hob(PIP, "Pip"));
});

const Persistence = Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive).pipe(
  Layer.provideMerge(TestDatabase),
);
const TestLayer = ChatService.layer
  .pipe(Layer.provide(HobTools.chatOnly))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effectDiscard(summonHobs).pipe(Layer.provideMerge(Persistence)),
        EventBus.layer,
        HobAdmission.layer,
        FakeRuntimeLayer(),
      ),
    ),
  );

describe("who answers a message you send", () => {
  // covers ADR 039 (Who answers, rule 4)
  it("[TC-OR-1460-10] starts the only hob's turn, and none in a camp with several hobs", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      const members = yield* ThreadMemberRepository;

      // Quill's first thread is its direct message; the next one is a camp, which Pip joins.
      const direct = yield* chat.createThread(QUILL);
      const camp = yield* chat.createThread(QUILL);
      yield* members.add(camp.id, hobActor(PIP), OWNER_ACTOR);

      const alone = yield* chat.sendPrompt(direct.id, "hello");
      yield* repo.listMessages(direct.id).pipe(
        Effect.flatMap((messages) =>
          messages.at(-1)?.status === "complete" && messages.at(-1)?.role === "assistant"
            ? Effect.void
            : Effect.fail("busy" as const),
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      const together = yield* chat.sendPrompt(camp.id, "morning, everyone");
      return {
        alone,
        together,
        direct: yield* repo.listMessages(direct.id),
        camp: yield* repo.listMessages(camp.id),
        running: yield* chat.activeThreads,
      };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.alone.assistantMessage).not.toBeNull();
    expect(result.direct.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(result.together.assistantMessage).toBeNull();
    expect(result.camp.map((m) => [m.role, m.content, m.status])).toEqual([["user", "morning, everyone", "complete"]]);
    expect(result.running).toEqual([]);
  }, 30_000);
});
