import { HobbotsRepository, type SentTo, ThreadMemberRepository } from "@hobbots/agents";
import {
  type Actor,
  Agent,
  AgentId,
  hobActor,
  Message,
  MessageId,
  type MessageStatus,
  mainLine,
  OWNER_ACTOR,
  QueuedMessageTransitions,
  Thread,
  ThreadId,
  TurnCause,
  type TurnRequest,
  TurnRequestState,
  TurnRequests,
} from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HobbotsRepositoryLive, migrations, ThreadMemberRepositoryLive } from "../src/index.ts";
import turnRequests, { TURN_CAUSES, TURN_REQUEST_STATES } from "../src/migrations/20261114003401_turn_requests.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1461 (ADR 039, One hob speaks at a time): each answer a hob owes is a TurnRequest written
// with the message that caused it; it takes the floor with its turn's reply, is answered when the
// turn ends, and is dropped by Stop and Stop all. The floor's queue is the records alone, so a
// restart rebuilds it. On SQLite and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-14T10:00:00.000Z";
const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const ROOK = AgentId.make("rook");
const HOBS = [QUILL, PIP, ROOK];
const MARINA: Actor = { kind: "user", id: "marina" };

type Services = HobbotsRepository | ThreadMemberRepository | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>, database: typeof TestDatabase = TestDatabase) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive).pipe(Layer.provideMerge(database)),
    ),
    Effect.runPromise,
  );

/** The migrations that ran before turn requests were recorded. */
const earlier = Object.fromEntries(
  Object.entries(migrations).filter(([id]) => id < "20261114003401"),
) as typeof migrations;

const hob = (id: AgentId) =>
  new Agent({
    id,
    name: id,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });

const summonAll = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const id of HOBS) yield* repo.insertAgent(hob(id));
});

/** A camp of Quill's that Pip and Rook joined. */
const campOfThree = (id: ThreadId) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const members = yield* ThreadMemberRepository;
    yield* repo.upsertThread(
      new Thread({ id, agentId: QUILL, title: id, kind: "camp", createdAt: NOW, updatedAt: NOW }),
    );
    yield* members.add(id, hobActor(PIP), OWNER_ACTOR);
    yield* members.add(id, hobActor(ROOK), OWNER_ACTOR);
  });

const said = (threadId: ThreadId, id: string, status: MessageStatus, actor: Actor = OWNER_ACTOR) =>
  new Message({
    id: MessageId.make(id),
    threadId,
    actor,
    role: "user",
    content: id,
    status,
    error: null,
    configVersion: null,
    createdAt: NOW,
  });

const replyTo = (threadId: ThreadId, id: string, hobId: AgentId) =>
  new Message({
    id: MessageId.make(id),
    threadId,
    actor: hobActor(hobId),
    role: "assistant",
    content: "",
    status: "streaming",
    error: null,
    configVersion: 1,
    createdAt: NOW,
  });

const mentioning = (hobs: ReadonlyArray<AgentId>): SentTo => ({ mentions: hobs.map(hobActor), repliesTo: null });

const open = (threadId: ThreadId) =>
  Effect.flatMap(HobbotsRepository, (repo) => repo.openTurnRequests(mainLine(threadId)));

/** Gives the floor to `next` as the hub does: a queued message starts with it, a said one is its prompt. */
const speak = (next: TurnRequest, replyId: string) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const message = Option.getOrThrow(yield* repo.findMessage(next.messageId));
    const reply = replyTo(next.threadId, replyId, next.hobId);
    const started = QueuedMessageTransitions.start(message);
    return started instanceof Message
      ? Option.isSome(yield* repo.startQueuedMessage(started, reply, [next.id]))
      : Option.isSome(yield* repo.startReply(reply, [next.id]));
  });

describe("turn requests as records", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("[TC-PE-1461-01] writes one waiting request per hob owed, in mention order, with the message", async () => {
    const camp = ThreadId.make("camp");
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* summonAll;
        yield* campOfThree(camp);
        const sent = yield* repo.sendMessage(said(camp, "m-1", "complete", MARINA), mentioning([ROOK, PIP, ROOK]));
        const relayed = yield* repo.sendMessage(said(camp, "m-2", "queued", hobActor(PIP)), {
          ...mentioning([QUILL]),
          relayDepth: 2,
        });
        const nobody = yield* repo.sendMessage(said(camp, "m-3", "queued"), mentioning([]));
        return { sent, relayed, nobody, open: yield* open(camp) };
      }),
    );
    expect(result.sent.value.requests.map((r) => [r.hobId, r.cause, r.state, r.relayDepth, r.causedBy])).toEqual([
      [ROOK, "mention", "waiting", 0, MARINA],
      [PIP, "mention", "waiting", 0, MARINA],
    ]);
    expect(result.relayed.value.requests.map((r) => [r.hobId, r.cause, r.relayDepth])).toEqual([[QUILL, "relay", 2]]);
    // Nobody owes it an answer, so it is stored said and never waits.
    expect(result.nobody.value.requests).toEqual([]);
    expect(result.nobody.value.message.status).toBe("complete");
    expect(result.open.map((r) => [r.hobId, r.messageId])).toEqual([
      [ROOK, "m-1"],
      [PIP, "m-1"],
      [QUILL, "m-2"],
    ]);
  });

  // covers ADR 039 (One hob speaks at a time)
  it("[TC-PE-1461-02] takes the floor with the turn's reply, or neither, and drops what a removed message was owed", async () => {
    const camp = ThreadId.make("camp");
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* summonAll;
        yield* campOfThree(camp);
        yield* repo.sendMessage(said(camp, "m-1", "complete"), mentioning([PIP, ROOK]));
        yield* repo.sendMessage(said(camp, "m-2", "queued"), mentioning([QUILL]));
        const [pip, rook, quill] = yield* open(camp);
        if (pip === undefined || rook === undefined || quill === undefined) throw new Error("three requests");
        const spoke = yield* speak(pip, "reply-pip");
        // Stop all drops Rook's request meanwhile: its turn does not start, and no reply is saved.
        yield* repo.dropTurnRequests([rook.id], MARINA);
        const late = yield* repo.startReply(replyTo(camp, "reply-rook", ROOK), [rook.id]);
        yield* repo.answerTurnRequests(MessageId.make("reply-pip"));
        yield* repo.removeQueuedMessage(camp, MessageId.make("m-2"));
        return {
          spoke,
          late,
          open: yield* open(camp),
          messages: (yield* repo.listMessages(camp)).map((m) => m.id),
        };
      }),
    );
    expect(result.spoke).toBe(true);
    expect(Option.isNone(result.late)).toBe(true);
    expect(result.messages).toEqual(["m-1", "reply-pip"]);
    expect(result.open).toEqual([]);
  });
});

describe("recording the answers already owed", () => {
  // covers ADR 039 (One hob speaks at a time, Restart)
  it("[TC-PE-1461-04] gives each message still queued a waiting request for its thread's hob, in queue order", async () => {
    const chat = ThreadId.make("chat");
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* repo.insertAgent(hob(QUILL));
        yield* repo.upsertThread(
          new Thread({ id: chat, agentId: QUILL, title: "chat", createdAt: NOW, updatedAt: NOW }),
        );
        yield* repo.upsertMessage(said(chat, "first", "complete"));
        yield* repo.upsertMessage(said(chat, "second", "queued"));
        yield* repo.upsertMessage(said(chat, "third", "queued", MARINA));
        yield* turnRequests;
        return yield* open(chat);
      }),
      TestDatabaseAt(earlier),
    );
    expect(result.map((r) => [r.hobId, r.messageId, r.causedBy, r.cause, r.state, r.relayDepth])).toEqual([
      [QUILL, "second", OWNER_ACTOR, "only-hob", "waiting", 0],
      [QUILL, "third", MARINA, "only-hob", "waiting", 0],
    ]);
  });

  // covers ADR 039 (One hob speaks at a time)
  it("[TC-PE-1461-05] refuses a request state or cause outside the domain's, on insert and on update", async () => {
    // A new state or cause needs a migration of its own.
    expect(TURN_REQUEST_STATES).toEqual(TurnRequestState.literals);
    expect(TURN_CAUSES).toEqual(TurnCause.literals);
    const camp = ThreadId.make("camp");
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HobbotsRepository;
        yield* summonAll;
        yield* campOfThree(camp);
        yield* repo.sendMessage(said(camp, "m-1", "complete"), mentioning([PIP]));
        const row = {
          id: "r-x",
          threadId: camp,
          hobId: PIP,
          messageId: "m-1",
          causedByKind: "user",
          causedById: "owner",
          relayDepth: 0,
          queuedAt: 1,
          position: 0,
          createdAt: NOW,
        };
        const state = yield* Effect.exit(
          sql`INSERT INTO turn_requests ${sql.insert({ ...row, cause: "mention", state: "queued" })}`,
        );
        const cause = yield* Effect.exit(
          sql`INSERT INTO turn_requests ${sql.insert({ ...row, cause: "wake-all", state: "waiting" })}`,
        );
        const updated = yield* Effect.exit(sql`UPDATE turn_requests SET state = 'queued'`);
        return { state, cause, updated, open: yield* open(camp) };
      }),
    );
    for (const exit of [result.state, result.cause, result.updated]) expect(Exit.isFailure(exit)).toBe(true);
    expect(result.open.map((r) => r.state)).toEqual(["waiting"]);
  });
});

// A script of sends, starts, ends, Stop, Stop all, removals and restarts over a camp of three hobs,
// played on the records and on a model of the floor. After every step the open requests, in floor
// order, and each message's place in the queue must agree. A restart keeps nothing but the records.

type Op =
  | { readonly _tag: "Send"; readonly hobs: ReadonlyArray<AgentId> }
  | { readonly _tag: "Start"; readonly away: ReadonlyArray<AgentId> }
  | { readonly _tag: "End" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "StopAll" }
  | { readonly _tag: "Remove"; readonly pick: number }
  | { readonly _tag: "Restart" };

const ops: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .subarray(HOBS)
      .chain((hobs) => fc.shuffledSubarray(hobs, { minLength: hobs.length }))
      .map((hobs) => ({ _tag: "Send", hobs }) as const),
  },
  { weight: 3, arbitrary: fc.subarray(HOBS, { maxLength: 2 }).map((away) => ({ _tag: "Start", away }) as const) },
  { weight: 2, arbitrary: fc.constant({ _tag: "End" } as const) },
  { weight: 1, arbitrary: fc.constant({ _tag: "Stop" } as const) },
  { weight: 1, arbitrary: fc.constant({ _tag: "StopAll" } as const) },
  { weight: 1, arbitrary: fc.nat(5).map((pick) => ({ _tag: "Remove", pick }) as const) },
  { weight: 1, arbitrary: fc.constant({ _tag: "Restart" } as const) },
);

interface Owed {
  readonly hob: AgentId;
  readonly message: string;
  readonly state: "waiting" | "speaking" | "answered" | "dropped";
}
interface Model {
  readonly owed: ReadonlyArray<Owed>;
  /** Each message you sent, and whether it is still queued. */
  readonly messages: ReadonlyArray<{ readonly id: string; readonly queued: boolean }>;
}

const stillOwed = (owed: ReadonlyArray<Owed>, message: string) =>
  owed.some((o) => o.message === message && (o.state === "waiting" || o.state === "speaking"));

/** The rules of ADR 039, kept apart from the hub's. */
const modelStep = (m: Model, op: Op, n: number): Model => {
  const speaking = m.owed.find((o) => o.state === "speaking");
  const dropping = (picked: (o: Owed) => boolean): Model => {
    const owed = m.owed.map((o) => (picked(o) ? { ...o, state: "dropped" as const } : o));
    // A queued message left with nothing owed leaves the queue said.
    return {
      owed,
      messages: m.messages.map((x) => (x.queued && !stillOwed(owed, x.id) ? { ...x, queued: false } : x)),
    };
  };
  switch (op._tag) {
    case "Send": {
      const lined = m.owed.some((o) => o.state === "waiting" || o.state === "speaking");
      return {
        owed: [...m.owed, ...op.hobs.map((hob): Owed => ({ hob, message: `m-${n}`, state: "waiting" }))],
        messages: [...m.messages, { id: `m-${n}`, queued: lined && op.hobs.length > 0 }],
      };
    }
    case "Start": {
      if (speaking !== undefined) return m;
      const next = m.owed.find((o) => o.state === "waiting" && !op.away.includes(o.hob));
      if (next === undefined) return m;
      return {
        owed: m.owed.map((o) => (o === next ? { ...o, state: "speaking" } : o)),
        messages: m.messages.map((x) => (x.id === next.message ? { ...x, queued: false } : x)),
      };
    }
    case "End":
    case "Restart":
      return { ...m, owed: m.owed.map((o) => (o.state === "speaking" ? { ...o, state: "answered" } : o)) };
    case "Stop":
      return speaking === undefined ? m : dropping((o) => o === speaking);
    case "StopAll":
      return dropping((o) => o.state === "waiting" || o.state === "speaking");
    case "Remove": {
      const queued = m.messages.filter((x) => x.queued);
      const removed = queued[op.pick % Math.max(1, queued.length)];
      if (removed === undefined) return m;
      return {
        owed: m.owed.map((o) => (o.message === removed.id && o.state === "waiting" ? { ...o, state: "dropped" } : o)),
        messages: m.messages.filter((x) => x !== removed),
      };
    }
  }
};

/** The same step on the records, through the repository as the hub uses it. */
const recordStep = (camp: ThreadId, op: Op, n: number) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const owed = yield* open(camp);
    const speaking = TurnRequests.speaking(owed);
    switch (op._tag) {
      case "Send": {
        const lined = owed.some((r) => TurnRequests.isWaiting(r) || TurnRequests.isSpeaking(r));
        yield* repo.sendMessage(said(camp, `${camp}:m-${n}`, lined ? "queued" : "complete"), mentioning(op.hobs));
        return;
      }
      case "Start": {
        const next = TurnRequests.next(owed, (r) => !op.away.includes(r.hobId));
        if (next !== null) yield* speak(next, `${camp}:reply-${n}`);
        return;
      }
      case "End":
        if (speaking?.replyId != null) yield* repo.answerTurnRequests(speaking.replyId);
        return;
      case "Restart":
        yield* repo.answerUnfinishedTurnRequests;
        return;
      case "Stop":
        yield* repo.dropTurnRequests(
          TurnRequests.stopping(owed).map((r) => r.id),
          MARINA,
        );
        return;
      case "StopAll":
        yield* repo.dropTurnRequests(
          TurnRequests.stoppingAll(owed).map((r) => r.id),
          MARINA,
        );
        return;
      case "Remove": {
        const queued = (yield* repo.listMessages(camp)).filter((x) => x.role === "user" && x.status === "queued");
        const removed = queued[op.pick % Math.max(1, queued.length)];
        if (removed !== undefined) yield* repo.removeQueuedMessage(camp, removed.id);
        return;
      }
    }
  });

describe("the floor's queue on the records", () => {
  // covers ADR 039 (One hob speaks at a time, Restart)
  it("[TC-PE-1461-03] agrees with a model of the floor across three hobs, whatever sends, stops, removals and restarts do", async () => {
    let camps = 0;
    await run(
      Effect.gen(function* () {
        yield* summonAll;
        const repo = yield* HobbotsRepository;
        const members = yield* ThreadMemberRepository;
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(fc.array(ops, { maxLength: 16 }), (script) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const camp = ThreadId.make(`camp-${camps++}`);
                  yield* campOfThree(camp);
                  let model: Model = { owed: [], messages: [] };
                  for (const [i, op] of script.entries()) {
                    model = modelStep(model, op, i + 1);
                    yield* recordStep(camp, op, i + 1);
                    const owed = yield* open(camp);
                    expect(owed.map((r) => [r.hobId, r.messageId, r.state])).toEqual(
                      model.owed
                        .filter((o) => o.state === "waiting" || o.state === "speaking")
                        .map((o) => [o.hob, `${camp}:${o.message}`, o.state]),
                    );
                    const yours = (yield* repo.listMessages(camp)).filter((x) => x.role === "user");
                    expect(yours.map((x) => [x.id, x.status === "queued"]).toSorted()).toEqual(
                      model.messages.map((x) => [`${camp}:${x.id}`, x.queued]).toSorted(),
                    );
                  }
                }).pipe(
                  Effect.provideService(HobbotsRepository, repo),
                  Effect.provideService(ThreadMemberRepository, members),
                ),
              ),
            ),
            { numRuns: 30 },
          ),
        );
      }),
    );
  }, 120_000);
});
