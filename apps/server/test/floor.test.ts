import { ChatService, HobAdmission, HobbotsRepository, HobTools, ThreadMemberRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  hobActor,
  isInProgress,
  Message,
  MessageId,
  OWNER_ACTOR,
  Thread,
  ThreadId,
  type ThreadRunStatus,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, ThreadMemberRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, PubSub, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

// Issue #1461 (ADR 039, One hob speaks at a time): a camp's main line gives its floor to one hob at
// a time, the oldest request first, and says who speaks and who is next. The queue is the records,
// so a hub that starts again picks it up where it was. Stop all drops what is still owed.

const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const ROOK = AgentId.make("rook");
const CAMP = ThreadId.make("camp");
const NOW = "2026-11-14T10:00:00.000Z";

const hob = (id: AgentId) =>
  new Agent({
    id,
    name: id,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: `You are ${id}.`,
    lookSeed: 4821,
    lookColor: "violet",
    configVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

/** Quill's camp, which Pip and Rook joined. */
const campOfThree = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const members = yield* ThreadMemberRepository;
  for (const id of [QUILL, PIP, ROOK]) yield* repo.insertAgent(hob(id));
  yield* repo.upsertThread(
    new Thread({ id: CAMP, agentId: QUILL, title: "Plans", kind: "camp", createdAt: NOW, updatedAt: NOW }),
  );
  yield* members.add(CAMP, hobActor(PIP), OWNER_ACTOR);
  yield* members.add(CAMP, hobActor(ROOK), OWNER_ACTOR);
});

/** A person's message that mentions `hobs`, in that order. */
const mention = (id: string, hobs: ReadonlyArray<AgentId>, status: Message["status"] = "complete") =>
  Effect.flatMap(HobbotsRepository, (repo) =>
    repo.sendMessage(
      new Message({
        id: MessageId.make(id),
        threadId: CAMP,
        actor: OWNER_ACTOR,
        role: "user",
        content: id,
        status,
        error: null,
        configVersion: null,
        createdAt: NOW,
      }),
      { mentions: hobs.map(hobActor), repliesTo: null },
    ),
  );

const Persistence = Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive).pipe(
  Layer.provideMerge(TestDatabase),
);

/** A hub over `seed`: what an earlier life of the hub left in the camp before this one started. */
const hubOver = (
  seed: Effect.Effect<unknown, unknown, HobbotsRepository | ThreadMemberRepository>,
  delay: `${number} millis` | `${number} second`,
) =>
  ChatService.layer.pipe(
    Layer.provide(HobTools.chatOnly),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effectDiscard(Effect.orDie(seed)).pipe(Layer.provideMerge(Persistence)),
        EventBus.layer,
        HobAdmission.layer,
        FakeRuntimeLayer({ delay }),
      ),
    ),
  );

/** Waits until nothing streams or waits in the camp and no turn runs. */
const settled = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const chat = yield* ChatService;
  yield* Effect.gen(function* () {
    const messages = yield* repo.listMessages(CAMP);
    const owed = yield* repo.openTurnRequests({ threadId: CAMP, rootMessageId: null });
    const running = yield* chat.activeThreads;
    const busy = owed.length > 0 || running.length > 0 || messages.some((m) => isInProgress(m.status));
    if (busy) return yield* Effect.fail("busy" as const);
  }).pipe(Effect.retry(Schedule.spaced("5 millis")));
  return yield* repo.listMessages(CAMP);
});

/** Every request in the camp, as stored, oldest first. */
const allRequests = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{
    readonly hobId: string;
    readonly messageId: string;
    readonly state: string;
    readonly replyId: string | null;
    readonly droppedByKind: string | null;
    readonly droppedById: string | null;
  }>`SELECT hob_id, message_id, state, reply_id, dropped_by_kind, dropped_by_id FROM turn_requests
    WHERE thread_id = ${CAMP} ORDER BY queued_at, position`.pipe(Effect.orDie),
);

const replies = (messages: ReadonlyArray<Message>) =>
  messages.filter((m) => m.role === "assistant").map((m) => [m.actor?.id, m.promptId, m.status]);

describe("one hob speaks at a time", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("[TC-CH-1461-01] gives the floor to each mentioned hob in turn, saying who speaks and who is next", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const bus = yield* EventBus;
      const subscription = yield* bus.subscribe;
      yield* mention("plan", [PIP, ROOK]);
      yield* mention("later", [QUILL]);
      yield* chat.wake(CAMP);
      const messages = yield* settled;
      const runs = (yield* PubSub.takeAll(subscription)).flatMap(
        (event): ReadonlyArray<ThreadRunStatus> =>
          event._tag === "Transient" && event.event._tag === "ThreadRunChanged" ? [event.event.run] : [],
      );
      return { messages, runs, requests: yield* allRequests };
    }).pipe(Effect.provide(hubOver(campOfThree, "2 millis")), Effect.scoped, Effect.runPromise);

    expect(replies(result.messages)).toEqual([
      [PIP, "plan", "complete"],
      [ROOK, "plan", "complete"],
      [QUILL, "later", "complete"],
    ]);
    // Who held the floor as each turn started, and who waited behind it.
    const starts = result.runs.filter((run) => run.run === "running" && run.reply === "thinking");
    expect(starts.map((run) => [run.speaking, run.next])).toEqual([
      [PIP, [ROOK, QUILL]],
      [ROOK, [QUILL]],
      [QUILL, []],
    ]);
    expect(result.runs.every((run) => run.rootMessageId === null && run.threadId === CAMP)).toBe(true);
    expect(result.requests.map((r) => [r.hobId, r.state])).toEqual([
      [PIP, "answered"],
      [ROOK, "answered"],
      [QUILL, "answered"],
    ]);
  }, 30_000);

  // covers ADR 039 (One hob speaks at a time, Restart)
  it("[TC-CH-1461-02] starts the requests an earlier life of the hub left waiting, in their order", async () => {
    const left = Effect.gen(function* () {
      yield* campOfThree;
      yield* mention("first", [ROOK]);
      yield* mention("second", [PIP, QUILL], "queued");
    });
    const result = await Effect.gen(function* () {
      return { messages: yield* settled, requests: yield* allRequests };
    }).pipe(Effect.provide(hubOver(left, "2 millis")), Effect.scoped, Effect.runPromise);

    expect(replies(result.messages)).toEqual([
      [ROOK, "first", "complete"],
      [PIP, "second", "complete"],
      [QUILL, "second", "complete"],
    ]);
    expect(result.messages.filter((m) => m.role === "user").map((m) => [m.id, m.status])).toEqual([
      ["first", "complete"],
      ["second", "complete"],
    ]);
    expect(result.requests.map((r) => r.state)).toEqual(["answered", "answered", "answered"]);
  }, 30_000);

  // covers ADR 039 (One hob speaks at a time, Stop all)
  it("[TC-CH-1461-03] Stop all stops the hob speaking and drops what is still owed, recording who stopped it", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const repo = yield* HobbotsRepository;
      yield* mention("plan", [PIP, ROOK]);
      yield* mention("then", [QUILL], "queued");
      yield* chat.wake(CAMP);
      // Pip holds the floor, so the stop finds its turn running.
      yield* repo.listMessages(CAMP).pipe(
        Effect.flatMap((messages) =>
          messages.some((m) => m.role === "assistant" && m.status === "streaming")
            ? Effect.void
            : Effect.fail("not yet" as const),
        ),
        Effect.retry(Schedule.spaced("5 millis")),
      );
      yield* chat.stopAll(CAMP);
      return { messages: yield* settled, requests: yield* allRequests };
    }).pipe(Effect.provide(hubOver(campOfThree, "1 second")), Effect.scoped, Effect.runPromise);

    expect(replies(result.messages)).toEqual([[PIP, "plan", "stopped"]]);
    const owner: ReadonlyArray<string> = [OWNER_ACTOR.kind, OWNER_ACTOR.id];
    expect(result.requests.map((r) => [r.hobId, r.state, r.droppedByKind, r.droppedById])).toEqual([
      [PIP, "dropped", ...owner],
      [ROOK, "dropped", ...owner],
      [QUILL, "dropped", ...owner],
    ]);
    // The queued message stays said, with nobody left to answer it.
    expect(result.messages.find((m) => m.id === "then")?.status).toBe("complete");
  }, 30_000);

  // covers ADR 039 (Who answers, One hob speaks at a time)
  it("[TC-CH-1461-04] starts the hob you @mention in a camp, not the camp's own hob", async () => {
    const result = await Effect.gen(function* () {
      const chat = yield* ChatService;
      const sent = yield* chat.sendPrompt(CAMP, "@rook what do you think?");
      return { sent, messages: yield* settled, requests: yield* allRequests };
    }).pipe(Effect.provide(hubOver(campOfThree, "2 millis")), Effect.scoped, Effect.runPromise);

    expect(result.sent.assistantMessage?.actor).toEqual(hobActor(ROOK));
    expect(replies(result.messages).map(([hobId, , status]) => [hobId, status])).toEqual([[ROOK, "complete"]]);
    expect(result.requests.map((r) => [r.hobId, r.state])).toEqual([[ROOK, "answered"]]);
  }, 30_000);
});
