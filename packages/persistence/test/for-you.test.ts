import {
  ApprovalRepository,
  CatchUps,
  ForYouList,
  ForYouRepository,
  HobbotsRepository,
  RecordRepository,
  ThreadMemberRepository,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  type Actor,
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  DecisionId,
  DeviceId,
  hobActor,
  Message,
  MessageId,
  OWNER_ACTOR,
  OWNER_USER_ID,
  Thread,
  ThreadId,
  UserId,
} from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  ApprovalRepositoryLive,
  CatchUpRepositoryLive,
  EventJournal,
  ForYouRepositoryLive,
  HobbotsRepositoryLive,
  RecordRepositoryLive,
  TaskRepositoryLive,
  ThreadMemberRepositoryLive,
} from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1456 (ADR 039, Cards every thread shares › For you): each person's For you list comes from
// the records past their own read marker, and its While you were away is the catch-up each of them
// sees in that camp. On SQLite and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-14T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const CAMP = ThreadId.make("winter-market");
const BRUNA: Actor = { kind: "user", id: "bruna" };
const LEO: Actor = { kind: "user", id: "leo" };

const stores = Layer.mergeAll(
  HobbotsRepositoryLive,
  ThreadMemberRepositoryLive,
  RecordRepositoryLive,
  ApprovalRepositoryLive,
  TaskRepositoryLive,
  ForYouRepositoryLive,
  CatchUpRepositoryLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | ForYouList
    | CatchUps
    | ForYouRepository
    | HobbotsRepository
    | ThreadMemberRepository
    | RecordRepository
    | ApprovalRepository
    | SqlClient.SqlClient
  >,
) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(ForYouList.layer, CatchUps.layer).pipe(Layer.provideMerge(stores))),
    Effect.runPromise,
  );

/** A request from `actor`'s own device: the session the hub's device middleware provides. */
const as = (actor: Actor) =>
  Effect.provideService(UserSession, {
    deviceId: DeviceId.make(`${actor.id}-browser`),
    name: `${actor.id}'s browser`,
    kind: "browser",
    userId: UserId.make(actor.id === OWNER_ACTOR.id ? OWNER_USER_ID : actor.id),
    actor,
    whileApproved: (write) => write,
  });

let next = 0;
const message = (actor: Actor | null, content: string) =>
  new Message({
    id: MessageId.make(`m${++next}`),
    threadId: CAMP,
    actor,
    role: actor === null ? "assistant" : "user",
    content,
    status: "complete",
    error: null,
    configVersion: actor === null ? 1 : null,
    createdAt: NOW,
    revision: 0,
  });

const approval = new ApprovalRequest({
  id: ApprovalId.make("rm-notes"),
  agentId: ALDRIC,
  threadId: CAMP,
  messageId: null,
  stepId: "tool-1",
  tool: "Bash",
  operation: "delete-files",
  targets: ["scratch/notes.txt"],
  arguments: { command: "rm scratch/notes.txt" },
  label: "Running rm scratch/notes.txt",
  reason: "Deleting files asks first.",
  actionDigest: "d".repeat(64),
  policyVersion: "r1",
  state: "pending",
  denyReason: null,
  createdAt: NOW,
  decidedAt: null,
});

/**
 * The owner's camp with Aldric, Bruna and Leo in it: Leo asks Bruna, Aldric answers Leo, Bruna
 * records a decision, Aldric waits for an approval, and Leo reads up to his own message.
 */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* repo.insertAgent(
    new Agent({
      id: ALDRIC,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: NOW,
    }),
  );
  for (const [id, name] of [
    ["bruna", "Bruna"],
    ["leo", "Leo"],
  ] as const)
    yield* sql`INSERT INTO users ${sql.insert({ id, name, initials: name[0] ?? "", color: "moss", state: "active" })}`;
  yield* repo.makeCamp(
    new Thread({ id: CAMP, agentId: ALDRIC, title: "Winter Market", kind: "camp", createdAt: NOW, updatedAt: NOW }),
  );
  const members = yield* ThreadMemberRepository;
  yield* members.add(CAMP, BRUNA, OWNER_ACTOR);
  yield* members.add(CAMP, LEO, OWNER_ACTOR);
  const asked = yield* repo.upsertMessage(message(LEO, "@Bruna can you check the map?"));
  const answered = yield* repo.upsertMessage(message(null, "@Leo the photos are in"));
  yield* (yield* RecordRepository).recordDecision({
    id: DecisionId.make("price"),
    threadId: CAMP,
    sourceMessageId: null,
    text: "Tickets cost 12",
    replaces: null,
    actor: BRUNA,
    key: "app:price",
    input: "price",
    at: NOW,
  });
  yield* (yield* ApprovalRepository).insert(approval);
  yield* repo.markThreadRead(CAMP, asked.value.id, asked.value.revision).pipe(as(LEO));
  return { asked: asked.value.id, answered: answered.value.id };
});

describe("For you", () => {
  // covers ADR 039 (Cards every thread shares › For you; Users as actors)
  it("[TC-PE-1456-01] gives Bruna, Leo and the owner their own lists from the same camp, each item for its person", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ids = yield* seed;
        const list = yield* ForYouList;
        const catchUps = yield* CatchUps;
        const of = (actor: Actor) => Effect.all({ forYou: list.current, catchUp: catchUps.of(CAMP) }).pipe(as(actor));
        return { ids, bruna: yield* of(BRUNA), leo: yield* of(LEO), owner: yield* of(OWNER_ACTOR) };
      }),
    );
    const { ids, bruna, leo, owner } = result;
    const summary = (items: ReadonlyArray<{ readonly _tag: string; readonly for: Actor }>) =>
      items.map((item) => [item._tag, item.for.id]);
    expect(summary(bruna.forYou.items)).toEqual([["Mention", "bruna"]]);
    expect(bruna.forYou.items[0]).toMatchObject({ messageId: ids.asked, author: LEO, threadId: CAMP });
    expect(summary(leo.forYou.items)).toEqual([["Mention", "leo"]]);
    expect(leo.forYou.items[0]).toMatchObject({ messageId: ids.answered, author: hobActor(ALDRIC) });
    // The approval is the camp owner's to decide: nobody else's list has it.
    expect(summary(owner.forYou.items)).toEqual([["Approval", "owner"]]);
    // While you were away is what each person's catch-up of the camp lists, and Bruna's own
    // decision is news only to the others.
    for (const { forYou, catchUp } of [bruna, leo, owner]) {
      expect(forYou.away.map((part) => [part.threadId, part.items, part.more])).toEqual([
        [CAMP, catchUp.items, catchUp.more],
      ]);
    }
    expect(bruna.catchUp.items.map((item) => item._tag)).toEqual(["Mentioned"]);
    expect(leo.catchUp.items.map((item) => item._tag)).toEqual(["Mentioned", "Decided"]);
    expect(owner.catchUp.items.map((item) => item._tag)).toEqual(["Decided"]);
    expect(leo.forYou.away[0]?.readRevision).toBeGreaterThan(0);
  });

  // covers ADR 039 (Cards every thread shares › Approval: the decider)
  it("[TC-PE-1456-02] reads each thread's owner, and lists only the threads a person is an active member of", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const reads = yield* ForYouRepository;
        return {
          owners: yield* reads.owners,
          bruna: yield* reads.threads(BRUNA),
          stranger: yield* reads.threads({ kind: "user", id: "nobody" }),
          hob: yield* reads.threads(hobActor(ALDRIC)),
        };
      }),
    );
    expect(result.owners.get(CAMP)).toEqual(OWNER_ACTOR);
    expect(result.bruna.map((thread) => [thread.threadId, thread.marker, thread.messages.length])).toEqual([
      [CAMP, null, 1],
    ]);
    expect(result.bruna[0]?.decisions.map((decision) => decision.id)).toEqual(["price"]);
    expect(result.stranger).toEqual([]);
    // A hob is a member too, though nothing here mentions it.
    expect(result.hob.map((thread) => [thread.threadId, thread.messages.length])).toEqual([[CAMP, 0]]);
  });
});
