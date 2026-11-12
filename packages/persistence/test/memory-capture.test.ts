import { HobbotsRepository, MemoryCaptureLog, PrivateCamps } from "@hobbots/agents";
import { Agent, AgentId, TaskId, Thread, ThreadId } from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { DateTime, Duration, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, JOURNAL_RETENTION, MemoryCaptureLive, PrivateCampsLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, MemoryCaptureLive, PrivateCampsLive).pipe(
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
      yield* log.save(1, [session], [], { privateThreads: [], excluded: ["attempt:a1"] });
      const afterOne = yield* journal.compact;
      const held = yield* log.hold;
      yield* log.save(2, [], [threadId], { privateThreads: [], excluded: ["attempt:a1", "message:m2"] });
      const ended = yield* log.hold;
      yield* log.release;
      const released = yield* journal.compact;
      const again = yield* log.hold;
      return { first, kept, afterOne, held, ended, released, again };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.first).toEqual({ sequence: 10_003, sessions: [], exclusions: { privateThreads: [], excluded: [] } });
    expect(result.kept).toBe(0);
    expect(result.afterOne).toBe(1);
    expect(result.held).toEqual({
      sequence: 1,
      sessions: [{ sessionId: threadId, agentId, lastAt: now, lastKey: "message:m1" }],
      exclusions: { privateThreads: [], excluded: ["attempt:a1"] },
    });
    // A unit kept out again is kept once, and the ones kept before stay.
    expect(result.ended).toEqual({
      sequence: 2,
      sessions: [],
      exclusions: { privateThreads: [], excluded: ["attempt:a1", "message:m2"] },
    });
    // Released, compaction goes on as before, and the next hold starts at the head: the thread's
    // entry goes, and its first chapter's with it.
    expect(result.released).toBe(2);
    // Starting again at the head keeps what capture kept out.
    expect(result.again).toEqual({
      sequence: 10_003,
      sessions: [],
      exclusions: { privateThreads: [], excluded: ["attempt:a1", "message:m2"] },
    });
  });

  // covers ADR 037 (A camp is a thread with a kind), ADR 028 (Capture and summaries)
  it("[TC-GEN-1377-03] reads the camps private now and each Task's thread, and keeps the camps private at the cursor", async () => {
    const result = await Effect.gen(function* () {
      const log = yield* MemoryCaptureLog;
      const repo = yield* HobbotsRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const camp = ThreadId.make("camp");
      const campThread = new Thread({
        id: camp,
        agentId,
        title: "Offer letters",
        private: true,
        createdAt: now,
        updatedAt: now,
      });
      yield* repo.upsertThread(campThread);
      const task = (id: string, thread: ThreadId | null) =>
        sql`INSERT INTO tasks ${sql.insert({
          id,
          owner_id: agentId,
          parent_id: null,
          root_id: id,
          thread_id: thread,
          brief: "Draft it",
          state: "queued",
          created_at: now,
          updated_at: now,
        })}`;
      yield* task("in-camp", camp);
      yield* task("in-thread", threadId);
      yield* task("in-none", null);
      const ask = {
        threadIds: new Set([camp, threadId, ThreadId.make("gone")]),
        taskIds: new Set(["in-camp", "in-thread", "in-none", "gone"].map((id) => TaskId.make(id))),
      };
      const privateNow = yield* log.privacy(ask);
      const camps = yield* PrivateCamps;
      const holds = [
        yield* camps.holds({ threadId: camp }),
        yield* camps.holds({ threadId: null, taskId: TaskId.make("in-camp") }),
        yield* camps.holds({ threadId: threadId, taskId: TaskId.make("in-thread") }),
        yield* camps.holds({ threadId: null, taskId: TaskId.make("in-none") }),
      ];
      // A cursor that was not holding starts at the head, with the camps private now.
      const started = yield* log.hold;
      // Made public again: it is no longer private now, but the cursor keeps what it saved.
      yield* repo.upsertThread(new Thread({ ...campThread, private: false }));
      const publicAgain = yield* log.privacy(ask);
      const held = yield* log.hold;
      yield* log.save(started.sequence + 1, [], [], { privateThreads: [], excluded: [] });
      const followed = yield* log.hold;
      const none = yield* log.privacy({ threadIds: new Set(), taskIds: new Set() });
      return { privateNow, holds, started, publicAgain, held, followed, none };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const taskThreads = new Map([
      ["in-camp", "camp"],
      ["in-thread", "t1"],
    ]);
    expect(result.privateNow).toEqual({ privateNow: new Set(["camp"]), taskThreads });
    // A turn in the camp, or on a Task of it, is in a private camp; others are not.
    expect(result.holds).toEqual([true, true, false, false]);
    expect(result.started.exclusions.privateThreads).toEqual(["camp"]);
    expect(result.publicAgain).toEqual({ privateNow: new Set(), taskThreads });
    expect(result.held.exclusions.privateThreads).toEqual(["camp"]);
    expect(result.followed.exclusions.privateThreads).toEqual([]);
    expect(result.none).toEqual({ privateNow: new Set(), taskThreads: new Map() });
  });
});
