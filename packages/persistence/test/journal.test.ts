import { Agent, AgentId, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { DateTime, Duration, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepository, JOURNAL_RETENTION } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const Repositories = Layer.mergeAll(HobbotsRepository.layer, EventJournal.layer);
const TestLayer = Repositories.pipe(Layer.provideMerge(TestDatabase));
const now = "2026-10-30T00:00:00.000Z";
const agentId = AgentId.make("aldric");
const threadId = ThreadId.make("t1");

const agent = new Agent({
  id: agentId,
  name: "Aldric",
  roleTitle: "Guide",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1234,
  lookColor: "moss",
  configVersion: 1,
  createdAt: now,
});
const thread = new Thread({
  id: threadId,
  agentId,
  title: "New thread",
  runtimeSessionId: null,
  createdAt: now,
  updatedAt: now,
});
const message = (id: string, status: Message["status"], role: Message["role"] = "assistant") =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role,
    content: id,
    status,
    error: null,
    configVersion: role === "assistant" ? 1 : null,
    createdAt: now,
  });

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(agent);
  yield* repo.upsertThread(thread);
});

describe("EventJournal", () => {
  // covers DP-003
  it("[TC-DP-027] journals each change with its events in commit order, sets revisions, and leaves no gap when nothing changes", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const journal = yield* EventJournal;
      yield* seed;
      const queued = yield* repo.upsertMessage(message("q", "queued", "user"));
      const stopping = yield* repo.upsertMessage(message("r", "stopping"));
      // Conditional writes that change nothing append nothing and use no sequence.
      const reinserted = yield* repo.insertAgent(agent);
      const staleWake = yield* repo.setAgentStatus(new Agent({ ...agent, status: "active" }), "paused");
      const removedMissing = yield* repo.removeQueuedMessage(threadId, MessageId.make("missing"));
      const started = yield* repo.startQueuedMessage(
        new Message({ ...message("q", "queued", "user"), status: "complete" }),
        message("q-reply", "streaming"),
      );
      const removedStarted = yield* repo.removeQueuedMessage(threadId, MessageId.make("q"));
      return {
        entries: yield* journal.readAfter(0),
        head: yield* journal.head,
        returned: [queued, stopping].flatMap((c) => c.entries.map((e) => e.sequence)),
        startedSequences: Option.getOrThrow(started).entries.map((e) => e.sequence),
        noops: [
          Option.isNone(reinserted),
          Option.isNone(staleWake),
          Option.isNone(removedMissing),
          Option.isNone(removedStarted),
        ],
        messages: (yield* repo.listMessages(threadId)).map((m) => [m.id, m.revision]),
        agentRevision: Option.getOrThrow(yield* repo.findAgent(agentId)).revision,
        threadRevision: Option.getOrThrow(yield* repo.findThread(threadId)).revision,
      };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.entries.map((e) => [e.sequence, e.type])).toEqual([
      [1, "AgentUpserted"],
      [2, "ThreadUpserted"],
      [3, "MessageUpserted"],
      [4, "MessageQueued"],
      [5, "MessageUpserted"],
      [6, "TurnStopRequested"],
      [7, "MessageUpserted"],
      [8, "MessageDequeued"],
      [9, "MessageUpserted"],
    ]);
    expect(result.head.sequence).toBe(9);
    expect(result.head.epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.returned).toEqual([3, 4, 5, 6]);
    expect(result.startedSequences).toEqual([7, 8, 9]);
    expect(result.noops).toEqual([true, true, true, true]);
    // An entity's revision is the sequence of the entry that last wrote it.
    expect(result.agentRevision).toBe(1);
    expect(result.threadRevision).toBe(2);
    expect(result.messages).toEqual([
      ["r", 5],
      ["q", 7],
      ["q-reply", 9],
    ]);
    // Read back from storage, the envelope carries its payload, version and correlation.
    const [, threadEntry, queuedEntry] = result.entries;
    expect(threadEntry?.payload).toEqual({ _tag: "ThreadUpserted", thread: new Thread({ ...thread, revision: 2 }) });
    expect(queuedEntry?.payload).toEqual({
      _tag: "MessageUpserted",
      message: new Message({ ...message("q", "queued", "user"), revision: 3 }),
    });
    expect(queuedEntry?.schemaVersion).toBe(1);
    expect(queuedEntry?.causationId).toBeNull();
    expect(queuedEntry?.correlation).toEqual({ agentId, threadId, messageId: "q" });
    expect(new Set(result.entries.map((e) => e.id)).size).toBe(result.entries.length);
  });

  // covers DP-003
  it("[TC-DP-028] keeps a committed change's events when the process dies before publishing them", async () => {
    const result = await Effect.gen(function* () {
      // The first process commits a change and stops before anything is published.
      const before = yield* Effect.gen(function* () {
        yield* seed;
        const repo = yield* HobbotsRepository;
        return (yield* repo.upsertMessage(message("r", "interrupted"))).entries;
      }).pipe(Effect.provide(Layer.fresh(Repositories)));
      // The next one finds them in the journal.
      const after = yield* Effect.gen(function* () {
        const journal = yield* EventJournal;
        return yield* journal.readAfter(2);
      }).pipe(Effect.provide(Layer.fresh(Repositories)));
      return { before, after };
    }).pipe(Effect.provide(TestDatabase), Effect.scoped, Effect.runPromise);

    expect(result.after).toEqual(result.before);
    expect(result.after.map((e) => e.type)).toEqual(["MessageUpserted"]);
  });

  // covers DP-003
  it("[TC-DP-029] hands out unique, gap-free sequences to concurrent writers", async () => {
    const sequences = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const journal = yield* EventJournal;
      yield* seed;
      yield* Effect.forEach(
        Array.from({ length: 40 }, (_, i) => message(`m${i}`, i % 2 === 0 ? "complete" : "stopped")),
        (m) => repo.upsertMessage(m),
        { concurrency: "unbounded" },
      );
      return (yield* journal.readAfter(0)).map((e) => e.sequence);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    // Two entries for the agent and thread, then one or two per message.
    expect(sequences).toEqual(Array.from({ length: 2 + 20 + 40 }, (_, i) => i + 1));
  });

  // covers DP-003
  it("[TC-DP-030] compacts entries older than seven days outside the latest 10,000", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* EventJournal;
      yield* seed;
      const old = DateTime.formatIso(
        DateTime.subtractDuration(yield* DateTime.now, Duration.sum(JOURNAL_RETENTION.age, Duration.minutes(1))),
      );
      yield* sql`UPDATE event_journal SET occurred_at = ${old} WHERE sequence = 1`;
      // Within the latest 10,000, an old entry stays.
      const keptRecent = yield* journal.compact;
      // Once 10,000 newer entries exist, only the old one goes.
      yield* sql`UPDATE event_journal_head SET sequence = sequence + ${JOURNAL_RETENTION.entries}`;
      const deleted = yield* journal.compact;
      return {
        keptRecent,
        deleted,
        remaining: (yield* journal.readAfter(0)).map((e) => e.sequence),
        oldest: yield* journal.oldest,
      };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result).toEqual({ keptRecent: 0, deleted: 1, remaining: [2], oldest: 2 });
  });
});
