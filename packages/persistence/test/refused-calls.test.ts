import { HobbotsRepository, TaskRepository, TaskToolCalls } from "@hobbots/agents";
import { Agent, AgentId, TaskId, TaskToolRefused, Thread, ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "../src/index.ts";
import { REFUSED_INPUT_LIMIT } from "../src/task-tool-calls.ts";
import { TestDatabase } from "../src/testing.ts";

// Refused Task tool calls are recorded (#575), on SQLite and PostgreSQL (STD-TEST-006).

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | TaskToolCalls | EventJournal | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-01T00:00:00.000Z";
const later = "2026-11-01T00:05:00.000Z";
const FRODO = AgentId.make("frodo");
const threadId = ThreadId.make("t1");
const LEAD_TASK = TaskId.make("lead");

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: FRODO,
      name: "Frodo",
      roleTitle: "Lead",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    }),
  );
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: FRODO, title: "Quest", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  yield* tasks.createTask({
    task: {
      id: LEAD_TASK,
      ownerId: FRODO,
      parentId: null,
      threadId,
      brief: "Lead the Quest",
      dependsOn: [],
      createdAt: now,
    },
    delegation: null,
    milestones: [],
  });
});

const notYours = new TaskToolRefused({
  reason: "not-owner",
  message: "The user owns question d26a216f now, so only the user can answer it.",
});

const answerCall = (at: string) => ({
  agentId: FRODO,
  key: "answer-1",
  tool: "answer",
  input: '{"answer":"Use the blue one.","question_id":"d26a216f","turn_task":"lead"}',
  taskId: LEAD_TASK,
  refused: notYours,
  at,
});

const rows = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql<Record<string, unknown>>`SELECT * FROM task_tool_refusals ORDER BY created_at, call_key, id`,
  ),
);

describe("refused Task tool calls", () => {
  // covers OR-005, OR-007
  it("[TC-OR-300] a refused call is stored with its code and message, and a retry with its key is the same record", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const ledger = yield* TaskToolCalls;
        const journal = yield* EventJournal;
        const before = yield* journal.head;

        const first = yield* ledger.refused(answerCall(now));
        expect(first.value).toMatchObject({
          agentId: FRODO,
          taskId: LEAD_TASK,
          tool: "answer",
          key: "answer-1",
          reason: "not-owner",
          message: notYours.message,
          tries: 1,
          createdAt: now,
          refusedAt: now,
        });
        // The refusal is journaled, correlated with its hob and Task's thread.
        expect(first.entries).toHaveLength(1);
        expect(first.entries[0]).toMatchObject({
          type: "ToolCallRefused",
          correlation: { agentId: FRODO, threadId },
        });
        expect((yield* journal.head).sequence).toBe(before.sequence + 1);

        // Retried with the same key: the same record, tried twice, with the latest refusal.
        const again = yield* ledger.refused(answerCall(later));
        expect(again.value).toMatchObject({ id: first.value.id, tries: 2, createdAt: now, refusedAt: later });
        expect(yield* rows).toHaveLength(1);

        // The Task's tree carries it, so the Workbench Summary can show it.
        const tasks = yield* TaskRepository;
        const tree = Option.getOrThrow(yield* tasks.readTree(LEAD_TASK));
        expect(tree.refusals).toEqual([again.value]);
      }),
    );
  });

  // covers OR-007
  it("[TC-OR-301] a refused key stays free: a retry is decided again and is never replayed as done", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const ledger = yield* TaskToolCalls;
        const call = { agentId: FRODO, key: "answer-1", tool: "answer" as const, input: "{}", at: now };
        // The ledger's own refusal leaves no done row behind for the key.
        const refused = yield* Effect.flip(ledger.once(call, Effect.fail(notYours)));
        expect(refused).toBe(notYours);
        yield* ledger.refused({ ...answerCall(now), input: "{}" });
        let runs = 0;
        const done = yield* ledger.once(
          call,
          Effect.sync(() => {
            runs++;
            return { done: { message: "Answered", details: {} }, entries: [] };
          }),
        );
        expect(runs).toBe(1);
        expect(done.done.message).toBe("Answered");
        // The refusal is still on record: the call was refused before it was done.
        expect(yield* rows).toHaveLength(1);
      }),
    );
  });

  // covers OR-007
  it("[TC-OR-302] a call with no usable key, or no known Task, is a record of its own, with long input cut", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const ledger = yield* TaskToolCalls;
        const invalid = new TaskToolRefused({ reason: "invalid-input", message: "Expected a string at key" });
        const keyless = { ...answerCall(now), key: null, taskId: null, refused: invalid };
        const one = yield* ledger.refused({ ...keyless, input: "x".repeat(REFUSED_INPUT_LIMIT + 50) });
        const two = yield* ledger.refused(keyless);
        expect(two.value.id).not.toBe(one.value.id);
        expect(one.value.input).toHaveLength(REFUSED_INPUT_LIMIT);
        expect(one.value).toMatchObject({ key: null, taskId: null, reason: "invalid-input", tries: 1 });
        // A record with no Task is journaled for its hob alone.
        expect(one.entries[0]?.correlation).toMatchObject({ agentId: FRODO, threadId: null });
        expect(yield* rows).toHaveLength(2);
      }),
    );
  });
});
