import { HobbotsRepository, type SentTo, ThreadMemberRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  hobActor,
  Message,
  MessageId,
  mainLine,
  OWNER_ACTOR,
  Thread,
  ThreadId,
  type TurnRequest,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { HobbotsRepositoryLive, ThreadMemberRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1462 (ADR 039, One hob speaks at a time): a hob asked to answer that has nothing to add
// passes. Its request ends `passed` with its reason, and its reply goes in the same transaction,
// journaled `TurnPassed`, so the conversation keeps no message of that turn. On SQLite and
// PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-14T10:00:00.000Z";
const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const CAMP = ThreadId.make("camp");

type Services = HobbotsRepository | ThreadMemberRepository | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(HobbotsRepositoryLive, ThreadMemberRepositoryLive).pipe(Layer.provideMerge(TestDatabase)),
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

/** Quill's camp, which Pip joined, with your message that mentions Pip, then Quill. */
const asked = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const members = yield* ThreadMemberRepository;
  for (const id of [QUILL, PIP]) yield* repo.insertAgent(hob(id));
  yield* repo.upsertThread(
    new Thread({ id: CAMP, agentId: QUILL, title: "Plans", kind: "camp", createdAt: NOW, updatedAt: NOW }),
  );
  yield* members.add(CAMP, hobActor(PIP), OWNER_ACTOR);
  const sent: SentTo = { mentions: [hobActor(PIP), hobActor(QUILL)], repliesTo: null };
  yield* repo.sendMessage(
    new Message({
      id: MessageId.make("plan"),
      threadId: CAMP,
      actor: OWNER_ACTOR,
      role: "user",
      content: "What should we plant?",
      status: "complete",
      error: null,
      configVersion: null,
      createdAt: NOW,
    }),
    sent,
  );
});

/** Pip takes the floor, in a turn writing `reply-pip`. */
const pipSpeaks = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const [pip] = yield* repo.openTurnRequests(mainLine(CAMP));
  if (pip === undefined) throw new Error("Pip owes an answer");
  const reply = new Message({
    id: MessageId.make("reply-pip"),
    threadId: CAMP,
    actor: hobActor(PIP),
    role: "assistant",
    content: "",
    status: "streaming",
    error: null,
    configVersion: 1,
    createdAt: NOW,
  });
  expect(Option.isSome(yield* repo.startReply(reply, [pip.id]))).toBe(true);
  return reply.id;
});

/** Every request in the camp as stored, with its reason. */
const stored = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{
    readonly hobId: string;
    readonly state: string;
    readonly passReason: string | null;
  }>`SELECT hob_id, state, pass_reason FROM turn_requests WHERE thread_id = ${CAMP}
    ORDER BY queued_at, position`.pipe(Effect.orDie),
);

describe("passing", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("ends the request passed with its reason and removes the reply and what it asked, journaled TurnPassed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* asked;
        const replyId = yield* pipSpeaks;
        // Pip's reply asked Quill too, as a hob that mentions another does.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO turn_requests ${sql.insert({
          id: "relayed",
          thread_id: CAMP,
          root_message_id: null,
          hob_id: QUILL,
          message_id: replyId,
          caused_by_kind: "hob",
          caused_by_id: PIP,
          cause: "relay",
          relay_depth: 1,
          state: "waiting",
          reply_id: null,
          dropped_by_kind: null,
          dropped_by_id: null,
          pass_reason: null,
          queued_at: 99,
          position: 0,
          created_at: NOW,
        })}`;
        const speaking = yield* repo.turnRequestsOf(replyId);
        const passed = yield* repo.passTurnRequests(replyId, "Quill covered it");
        // The turn's end answers what is still speaking: nothing is left once it passed.
        yield* repo.answerTurnRequests(replyId);
        return {
          speaking,
          passed,
          rows: yield* stored,
          messages: (yield* repo.listMessages(CAMP)).map((m) => m.id),
          reply: yield* repo.findMessage(replyId),
          kept: yield* sql`SELECT reply_id, thread_id, agent_id FROM passed_turns`,
          versions: yield* repo.passedConfigVersions(CAMP, PIP),
          open: yield* repo.openTurnRequests(mainLine(CAMP)),
        };
      }),
    );
    expect(result.speaking.map((r) => [r.hobId, r.state])).toEqual([[PIP, "speaking"]]);
    expect(result.passed.value.map((r) => [r.hobId, r.state, r.passReason])).toEqual([
      [PIP, "passed", "Quill covered it"],
    ]);
    expect(result.passed.entries.map((entry) => entry.payload)).toEqual([
      {
        _tag: "TurnPassed",
        threadId: CAMP,
        messageId: "reply-pip",
        request: expect.objectContaining({ hobId: PIP, state: "passed", passReason: "Quill covered it" }),
      },
    ]);
    // What the removed reply asked of Quill goes with it; your own message's request stays.
    expect(result.rows).toEqual([
      { hobId: PIP, state: "passed", passReason: "Quill covered it" },
      { hobId: QUILL, state: "waiting", passReason: null },
      { hobId: QUILL, state: "dropped", passReason: null },
    ]);
    // The conversation keeps your message and no reply of Pip's; Quill is next.
    expect(result.messages).toEqual(["plan"]);
    expect(Option.isNone(result.reply)).toBe(true);
    // What the removed reply's turn used stays, under the hob that passed (OP-002).
    expect(result.kept).toEqual([{ replyId: "reply-pip", threadId: CAMP, agentId: PIP }]);
    // The configuration its session ran on stays too, so changed instructions still reach it.
    expect(result.versions).toEqual([1]);
    expect(result.open.map((r: TurnRequest) => [r.hobId, r.state])).toEqual([[QUILL, "waiting"]]);
  });

  // covers ADR 039 (One hob speaks at a time, Stop all)
  it("passes nothing and keeps the reply once Stop dropped the request it spoke for", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* asked;
        const replyId = yield* pipSpeaks;
        const [pip] = yield* repo.turnRequestsOf(replyId);
        if (pip === undefined) throw new Error("Pip speaks");
        yield* repo.dropTurnRequests([pip.id], OWNER_ACTOR);
        const passed = yield* repo.passTurnRequests(replyId, "Quill covered it");
        return { passed, rows: yield* stored, messages: (yield* repo.listMessages(CAMP)).map((m) => m.id) };
      }),
    );
    expect(result.passed.value).toEqual([]);
    expect(result.passed.entries).toEqual([]);
    expect(result.rows.map((r) => [r.hobId, r.state, r.passReason])).toEqual([
      [PIP, "dropped", null],
      [QUILL, "waiting", null],
    ]);
    expect(result.messages).toEqual(["plan", "reply-pip"]);
  });

  // covers ADR 039 (One hob speaks at a time), PE-003
  it("keeps a reply an approval names, and answers its request instead of passing it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* asked;
        const replyId = yield* pipSpeaks;
        yield* sql`INSERT INTO approval_requests ${sql.insert({
          id: "approval-1",
          agent_id: PIP,
          thread_id: CAMP,
          message_id: replyId,
          step_id: "step-1",
          tool: "Bash",
          operation: "run-commands",
          targets: "[]",
          arguments: "{}",
          label: "Running a command",
          reason: "",
          action_digest: "digest",
          policy_version: "1",
          state: "pending",
          created_at: NOW,
          revision: 1,
        })}`;
        const passed = yield* repo.passTurnRequests(replyId, "Quill covered it");
        return { passed, rows: yield* stored, messages: (yield* repo.listMessages(CAMP)).map((m) => m.id) };
      }),
    );
    expect(result.passed.value).toEqual([]);
    expect(result.rows.map((r) => [r.hobId, r.state])).toEqual([
      [PIP, "answered"],
      [QUILL, "waiting"],
    ]);
    expect(result.messages).toEqual(["plan", "reply-pip"]);
  });

  // covers ADR 039 (One hob speaks at a time), STD-DATA-001
  it("passes, when the hub starts again, a turn whose hob passed before the hub stopped", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* asked;
        const replyId = yield* pipSpeaks;
        // Pip passed, then the hub stopped before the turn ended.
        yield* repo.markPassing(replyId, "Quill covered it");
        yield* repo.answerUnfinishedTurnRequests;
        return { rows: yield* stored, messages: (yield* repo.listMessages(CAMP)).map((m) => m.id) };
      }),
    );
    expect(result.rows).toEqual([
      { hobId: PIP, state: "passed", passReason: "Quill covered it" },
      { hobId: QUILL, state: "waiting", passReason: null },
    ]);
    expect(result.messages).toEqual(["plan"]);
  });

  // covers ADR 039 (One hob speaks at a time), STD-DATA-001
  it("keeps, when the hub starts again, the reply of a hob that passed and then changed something", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        yield* asked;
        const replyId = yield* pipSpeaks;
        yield* repo.markPassing(replyId, "Quill covered it");
        // After passing, the turn edited a file, then the hub stopped.
        const [reply] = (yield* repo.listMessages(CAMP)).filter((m) => m.id === replyId);
        if (reply === undefined) throw new Error("Pip's reply is stored");
        yield* repo.upsertMessage(
          new Message({
            ...reply,
            steps: [
              {
                id: "s-1",
                kind: "tool",
                label: "Editing notes.md",
                state: "done",
                call: { tool: "Edit", operation: "edit-files", targets: ["/notes.md"] },
              },
            ],
          }),
        );
        yield* repo.answerUnfinishedTurnRequests;
        return { rows: yield* stored, messages: (yield* repo.listMessages(CAMP)).map((m) => m.id) };
      }),
    );
    expect(result.rows.map((r) => [r.hobId, r.state])).toEqual([
      [PIP, "answered"],
      [QUILL, "waiting"],
    ]);
    expect(result.messages).toEqual(["plan", "reply-pip"]);
  });
});
