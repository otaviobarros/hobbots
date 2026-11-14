import { HobbotsRepository, type SentTo, ThreadMemberRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  hobActor,
  MentionRefused,
  Message,
  MessageId,
  type MessageStatus,
  OWNER_ACTOR,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, ThreadMemberRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1460 (ADR 039, Who answers): the hub decides who answers a message you send in the same
// transaction that stores it, from the members and the running Quest as they stand then. On SQLite
// and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-13T10:00:00.000Z";
const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const ROOK = AgentId.make("rook");

type Services = HobbotsRepository | ThreadMemberRepository | EventJournal | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive, EventJournal.layer).pipe(
        Layer.provideMerge(TestDatabase),
      ),
    ),
    Effect.runPromise,
  );

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

/** Quill, Pip and Rook, and a camp of Quill's for each id. */
const setUp = (...camps: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const id of [QUILL, PIP, ROOK]) yield* repo.insertAgent(hob(id));
    for (const id of camps) {
      yield* repo.upsertThread(
        new Thread({ id, agentId: QUILL, title: id, kind: "camp", createdAt: NOW, updatedAt: NOW }),
      );
    }
  });

const yours = (threadId: ThreadId, status: MessageStatus = "complete") =>
  new Message({
    id: MessageId.make(crypto.randomUUID()),
    threadId,
    actor: OWNER_ACTOR,
    role: "user",
    content: "morning",
    status,
    error: null,
    configVersion: null,
    createdAt: NOW,
  });

const NOBODY: SentTo & { readonly mentions: readonly [] } = { mentions: [], repliesTo: null };
const send = (message: Message, to: SentTo) =>
  Effect.flatMap(HobbotsRepository, (repo) => repo.sendMessage(message, to));
const addPip = (threadId: ThreadId) =>
  Effect.flatMap(ThreadMemberRepository, (members) => members.add(threadId, hobActor(PIP), OWNER_ACTOR));
const answered = (sent: { readonly value: { readonly answerers: ReadonlyArray<{ readonly hobId: string }> } }) =>
  sent.value.answerers.map((answerer) => answerer.hobId);

describe("deciding who answers as a message is stored", () => {
  // covers ADR 039 (Who answers, rules 2 and 4)
  it("[TC-PE-1460-01] answers with the only hob, nobody once a second joins, a mentioned hob, and refuses a non-member", async () => {
    const camp = ThreadId.make("camp");
    const result = await run(
      Effect.gen(function* () {
        yield* setUp(camp);
        const alone = yield* send(yours(camp), NOBODY);
        yield* addPip(camp);
        const together = yield* send(yours(camp, "queued"), NOBODY);
        const mentioned = yield* send(yours(camp), { mentions: [hobActor(PIP), hobActor(QUILL)], repliesTo: null });
        const refused = yield* Effect.exit(send(yours(camp), { mentions: [hobActor(ROOK)], repliesTo: null }));
        const stored = yield* Effect.flatMap(HobbotsRepository, (repo) => repo.listMessages(camp));
        return { alone, together, mentioned, refused, stored };
      }),
    );
    expect(result.alone.value.answerers).toEqual([{ hobId: QUILL, cause: "only-hob" }]);
    expect(answered(result.together)).toEqual([]);
    // Nobody answers, so it never waits in the queue.
    expect(result.together.value.message.status).toBe("complete");
    expect(result.together.entries.map((entry) => entry.type)).toEqual(["MessageUpserted"]);
    expect(answered(result.mentioned)).toEqual([PIP, QUILL]);
    expect(result.refused).toEqual(Exit.fail(new MentionRefused({ threadId: camp, hobs: [ROOK] })));
    // The refused message was never stored.
    expect(result.stored).toHaveLength(3);
  });

  // covers ADR 039 (Who answers, rule 5)
  it("[TC-PE-1460-02] reaches a running Quest's lead with no mention, and its party member by mention", async () => {
    const camp = ThreadId.make("quest-camp");
    const result = await run(
      Effect.gen(function* () {
        yield* setUp(camp);
        yield* addPip(camp);
        const sql = yield* SqlClient.SqlClient;
        const task = (id: string, owner: AgentId, parent: string | null) =>
          sql`INSERT INTO tasks ${sql.insert({
            id,
            owner_id: owner,
            parent_id: parent,
            root_id: "k-lead",
            thread_id: camp,
            brief: id,
            state: "active",
            created_at: NOW,
            updated_at: NOW,
          })}`;
        yield* task("k-lead", QUILL, null);
        yield* task("k-rook", ROOK, "k-lead");
        yield* sql`INSERT INTO quests ${sql.insert({
          id: "q-lead",
          task_id: "k-lead",
          lead_id: QUILL,
          parent_quest_id: null,
          thread_id: camp,
          goal: "Plan the week",
          limits: "{}",
          depth: 1,
          state: "active",
          created_at: NOW,
        })}`;
        yield* sql`INSERT INTO delegations ${sql.insert({
          id: "d-rook",
          quest_id: "q-lead",
          lead_id: QUILL,
          member_id: ROOK,
          parent_task_id: "k-lead",
          child_task_id: "k-rook",
          brief: "Pick the days",
          authority: "{}",
          created_at: NOW,
        })}`;
        const plain = yield* send(yours(camp), NOBODY);
        const steer = yield* send(yours(camp), { mentions: [hobActor(ROOK)], repliesTo: null });
        yield* sql`UPDATE quests SET state = 'completed', ended_at = ${NOW} WHERE id = 'q-lead'`;
        const after = yield* send(yours(camp), NOBODY);
        return { plain, steer, after };
      }),
    );
    expect(result.plain.value.answerers).toEqual([{ hobId: QUILL, cause: "lead" }]);
    expect(result.steer.value.answerers).toEqual([{ hobId: ROOK, cause: "mention" }]);
    // Once the Quest ends, the camp's two hobs stay quiet without a mention.
    expect(answered(result.after)).toEqual([]);
  });

  // covers ADR 039 (Who answers), STD-ARCH-014
  it("[TC-PE-1460-03] decides from the members as the journal orders them when a hob joins at the same moment", async () => {
    const camps = Array.from({ length: 12 }, (_, index) => ThreadId.make(`race-${index}`));
    const results = await run(
      Effect.gen(function* () {
        yield* setUp(...camps);
        return yield* Effect.forEach(
          camps,
          (camp) =>
            Effect.all([send(yours(camp), NOBODY), addPip(camp)], { concurrency: 2 }).pipe(
              Effect.map(([sent, added]) => ({
                answerers: answered(sent),
                messageAt: sent.value.message.revision,
                joinedAt: added.value.revision,
              })),
            ),
          { concurrency: "unbounded" },
        );
      }),
    );
    for (const result of results) {
      // Pip counts exactly when it joined before the message in the journal.
      expect(result.answerers).toEqual(result.joinedAt < result.messageAt ? [] : [QUILL]);
    }
  });
});
