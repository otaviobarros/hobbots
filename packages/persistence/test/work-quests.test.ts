import { HobbotsRepository, WorkQuestRepository, type WorkQuestStart } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  Channel,
  ChannelId,
  Message,
  MessageId,
  OWNER_ACTOR,
  roleFields,
  TurnRequest,
  TurnRequestId,
  WorkQuestId,
} from "@hobbots/domain";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { HobbotsRepositoryLive, WorkQuestRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";
import { insertRequest } from "../src/turn-request-rows.ts";

// Issue #1596 (ADR 041): a Quest is started and finished in one transaction with its journal entry,
// its requester read from the turn request its reply answers, and a conversation runs one at a time.
// On SQLite and PostgreSQL alike.

const NOW = "2026-11-16T00:00:00.000Z";
const ADA = AgentId.make("ada");
const PIP = AgentId.make("pip");
const CHANNEL = ChannelId.make("camp-1");

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    ...roleFields("writer"),
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });

const message = (id: string, role: Message["role"]) =>
  new Message({
    id: MessageId.make(id),
    channelId: CHANNEL,
    actor: role === "user" ? OWNER_ACTOR : null,
    role,
    content: id,
    status: role === "user" ? "complete" : "streaming",
    error: null,
    configVersion: role === "user" ? null : (1 as Message["configVersion"]),
    createdAt: NOW,
  });

const layer = Layer.mergeAll(HobbotsRepositoryLive, WorkQuestRepositoryLive).pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | WorkQuestRepository | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E>);

/** Ada and Pip, Ada's camp, your ask and Ada's reply to it, which the turn request records. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(hob(ADA, "Ada"));
  yield* repo.insertAgent(hob(PIP, "Pip"));
  yield* repo.upsertChannel(
    new Channel({ id: CHANNEL, ownerHobId: ADA, title: "Shop", createdAt: NOW, updatedAt: NOW }),
  );
  yield* repo.upsertMessage(message("ask-1", "user"));
  for (const reply of ["reply-1", "reply-2", "reply-3"]) yield* repo.upsertMessage(message(reply, "assistant"));
  yield* insertRequest(
    yield* SqlClient.SqlClient,
    new TurnRequest({
      id: TurnRequestId.make("request-1"),
      channelId: CHANNEL,
      rootMessageId: null,
      hobId: ADA,
      messageId: MessageId.make("ask-1"),
      causedBy: OWNER_ACTOR,
      cause: "only-hob",
      relayDepth: 0,
      state: "speaking",
      replyId: MessageId.make("reply-1"),
      droppedBy: null,
      queuedAt: 1,
      position: 0,
      createdAt: NOW,
    }),
  );
});

const start = (fields: Partial<WorkQuestStart> = {}): WorkQuestStart => ({
  id: WorkQuestId.make("quest-1"),
  channelId: CHANNEL,
  rootMessageId: null,
  title: "Winter market page",
  goal: "A landing page for the winter market.",
  doneWhen: ["The page is live"],
  expectedBy: null,
  ownerHobId: ADA,
  repository: null,
  startedFrom: MessageId.make("reply-1"),
  at: NOW,
  ...fields,
});

const finish = (from: string, ownerHobId = ADA) => ({
  channelId: CHANNEL,
  rootMessageId: null,
  ownerHobId,
  result: "The page is live.",
  made: ["PR #12"],
  from: MessageId.make(from),
  at: NOW,
});

describe("Quests as work threads", () => {
  // covers ADR 041 (The record)
  it("starts a Quest asked by the person whose message the reply answers, journaled once (#1596)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const quests = yield* WorkQuestRepository;
        const first = yield* quests.start(start());
        const retried = yield* quests.start(start({ id: WorkQuestId.make("quest-other") }));
        return { first, retried, all: yield* quests.list(CHANNEL) };
      }),
    );
    expect(result.first.value).toMatchObject({ id: "quest-1", state: "active", requestedBy: OWNER_ACTOR });
    expect(result.first.entries.map((entry) => [entry.type, entry.correlation])).toEqual([
      ["WorkQuestStarted", { agentId: ADA, channelId: CHANNEL, messageId: "reply-1" }],
    ]);
    expect(result.first.value.revision).toBe(result.first.entries[0]?.sequence);
    // A retried call from the same reply returns the Quest it started, and journals nothing.
    expect(result.retried.entries).toEqual([]);
    expect(result.retried.value.id).toBe("quest-1");
    expect(result.all.map((quest) => quest.id)).toEqual(["quest-1"]);
  });

  // covers ADR 041 (Words: a conversation runs at most one Quest)
  it("refuses a second running Quest in the conversation, then starts one once the first is done (#1596)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const quests = yield* WorkQuestRepository;
        yield* quests.start(start());
        const busy = yield* Effect.exit(
          quests.start(start({ id: WorkQuestId.make("quest-2"), startedFrom: MessageId.make("reply-2") })),
        );
        yield* quests.finish(finish("reply-2"));
        const next = yield* quests.start(
          start({ id: WorkQuestId.make("quest-3"), title: "Gift cards", startedFrom: MessageId.make("reply-3") }),
        );
        return { busy, next: next.value, all: yield* quests.list(CHANNEL) };
      }),
    );
    expect(Exit.isFailure(result.busy) && JSON.stringify(result.busy.cause)).toContain("busy");
    // A reply with no turn request is the hob's own work: it asked for it itself.
    expect(result.next).toMatchObject({ id: "quest-3", requestedBy: { kind: "hob", id: ADA } });
    expect(result.all.map((quest) => [quest.id, quest.state])).toEqual([
      ["quest-1", "done"],
      ["quest-3", "active"],
    ]);
  });

  // covers ADR 041 (Tools)
  it("finishes only its owner's running Quest, once, with its result and what it made (#1596)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const quests = yield* WorkQuestRepository;
        yield* quests.start(start());
        const other = yield* Effect.exit(quests.finish(finish("reply-2", PIP)));
        const done = yield* quests.finish(finish("reply-2"));
        const retried = yield* quests.finish(finish("reply-2"));
        const again = yield* Effect.exit(quests.finish(finish("reply-3")));
        return { other, done, retried, again };
      }),
    );
    expect(Exit.isFailure(result.other) && JSON.stringify(result.other.cause)).toContain("none-running");
    expect(result.done.value).toMatchObject({
      state: "done",
      result: "The page is live.",
      made: ["PR #12"],
      finishedFrom: "reply-2",
    });
    expect(result.done.entries.map((entry) => entry.type)).toEqual(["WorkQuestChanged"]);
    expect(result.retried.entries).toEqual([]);
    expect(Exit.isFailure(result.again) && JSON.stringify(result.again.cause)).toContain("none-running");
  });
});
