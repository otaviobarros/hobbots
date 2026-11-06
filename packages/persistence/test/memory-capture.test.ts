import { HobbotsRepository, MemoryCaptureLog } from "@hobbots/agents";
import { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { DateTime, Duration, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, JOURNAL_RETENTION, MemoryCaptureLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, MemoryCaptureLive).pipe(
  Layer.provideMerge(EventJournal.layer),
  Layer.provideMerge(TestDatabase),
);
const now = "2026-11-05T00:00:00.000Z";
const agentId = AgentId.make("pip");
const threadId = ThreadId.make("t1");

/** A hob and a thread: two journal entries, the first made old enough to compact. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* repo.insertAgent(
    new Agent({
      id: agentId,
      name: "Pip",
      roleTitle: "Helper",
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
  yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "Tests", createdAt: now, updatedAt: now }));
  const old = DateTime.formatIso(
    DateTime.subtractDuration(yield* DateTime.now, Duration.sum(JOURNAL_RETENTION.age, Duration.days(1))),
  );
  yield* sql`UPDATE event_journal SET occurred_at = ${old}`;
  yield* sql`UPDATE event_journal_head SET sequence = sequence + ${JOURNAL_RETENTION.entries}`;
});

describe("MemoryCaptureLog", () => {
  // covers ADR 028 (When memory is down), DP-003
  it("[TC-GEN-308] keeps every journal entry after a holding capture cursor, however old, and saves the cursor with its sessions", async () => {
    const result = await Effect.gen(function* () {
      const log = yield* MemoryCaptureLog;
      const journal = yield* EventJournal;
      // Memory begins at the journal's head when it is first turned on.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_capture SET sequence = 0`;
      yield* seed;
      const first = yield* log.hold;
      // A cursor that was not holding starts again at the head, so take it back to before the seed.
      yield* sql`UPDATE memory_capture SET sequence = 0`;
      const kept = yield* journal.compact;
      const session = { sessionId: threadId, agentId, lastAt: now, lastKey: "message:m1" };
      yield* log.save(1, [session], []);
      const afterOne = yield* journal.compact;
      const held = yield* log.hold;
      yield* log.save(2, [], [threadId]);
      const ended = yield* log.hold;
      yield* log.release;
      const released = yield* journal.compact;
      const again = yield* log.hold;
      return { first, kept, afterOne, held, ended, released, again };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.first).toEqual({ sequence: 10_002, sessions: [] });
    expect(result.kept).toBe(0);
    expect(result.afterOne).toBe(1);
    expect(result.held).toEqual({
      sequence: 1,
      sessions: [{ sessionId: threadId, agentId, lastAt: now, lastKey: "message:m1" }],
    });
    expect(result.ended).toEqual({ sequence: 2, sessions: [] });
    // Released, compaction goes on as before, and the next hold starts at the head.
    expect(result.released).toBe(1);
    expect(result.again).toEqual({ sequence: 10_002, sessions: [] });
  });
});
