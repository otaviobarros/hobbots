import { HobbotsRepository, MemoryCaptureLog, PrivateCamps } from "@hobbots/agents";
import { Agent, AgentId, Message, MessageId, OWNER_ACTOR, TaskId, Channel, ChannelId } from "@hobbots/domain";
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
const channelId = ChannelId.make("t1");

/** A hob and a channel: two journal entries, the first made old enough to compact. */
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
  yield* repo.upsertChannel(new Channel({ id: channelId, ownerHobId: agentId, title: "Tests", createdAt: now, updatedAt: now }));
  const old = DateTime.formatIso(
    DateTime.subtractDuration(yield* DateTime.now, Duration.sum(JOURNAL_RETENTION.age, Duration.days(1))),
  );
  yield* sql`UPDATE event_journal SET occurred_at = ${old}`;
  yield* sql`UPDATE event_journal_head SET sequence = sequence + ${JOURNAL_RETENTION.entries}`;
  // The projectors have read it all, so only capture's cursor holds the journal here.
  yield* sql`UPDATE projector_cursors SET sequence = (SELECT sequence FROM event_journal_head WHERE id = 1)`;
});

describe("MemoryCaptureLog", () => {
  // covers ADR 028 (When memory is down), DP-003
  it("keeps every journal entry after a holding capture cursor, however old, and saves the cursor with its sessions", async () => {
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
      const session = { sessionId: channelId, agentId, lastAt: now, lastKey: "message:m1" };
      yield* log.save(1, [session], [], { privateChannels: [], excluded: ["attempt:a1"] });
      const afterOne = yield* journal.compact;
      const held = yield* log.hold;
      yield* log.save(2, [], [session], { privateChannels: [], excluded: ["attempt:a1", "message:m2"] });
      const ended = yield* log.hold;
      yield* log.release;
      const released = yield* journal.compact;
      const again = yield* log.hold;
      return { first, kept, afterOne, held, ended, released, again };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.first).toEqual({
      sequence: 10_005,
      since: expect.any(String),
      sessions: [],
      exclusions: { privateChannels: [], excluded: [] },
    });
    // A holding cursor keeps when it started from the head; starting from the head again moves it.
    const { since } = result.first;
    expect(result.kept).toBe(0);
    expect(result.afterOne).toBe(1);
    expect(result.held).toEqual({
      sequence: 1,
      since,
      sessions: [{ sessionId: channelId, agentId, lastAt: now, lastKey: "message:m1" }],
      exclusions: { privateChannels: [], excluded: ["attempt:a1"] },
    });
    // A unit kept out again is kept once, and the ones kept before stay.
    expect(result.ended).toEqual({
      sequence: 2,
      since,
      sessions: [],
      exclusions: { privateChannels: [], excluded: ["attempt:a1", "message:m2"] },
    });
    // Released, compaction goes on as before, and the next hold starts at the head: the channel's
    // entry goes, and its first chapter's and first members' with it.
    expect(result.released).toBe(4);
    // Starting again at the head keeps what capture kept out.
    expect(result.again).toEqual({
      sequence: 10_005,
      since: expect.any(String),
      sessions: [],
      exclusions: { privateChannels: [], excluded: ["attempt:a1", "message:m2"] },
    });
  });

  // covers ADR 037 (A camp is a channel with a kind), ADR 028 (Capture and summaries)
  it("reads the camps private now and each Task's channel, and keeps the camps private at the cursor (#1377)", async () => {
    const result = await Effect.gen(function* () {
      const log = yield* MemoryCaptureLog;
      const repo = yield* HobbotsRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const camp = ChannelId.make("camp");
      const campChannel = new Channel({
        id: camp,
        ownerHobId: agentId,
        title: "Offer letters",
        private: true,
        createdAt: now,
        updatedAt: now,
      });
      yield* repo.upsertChannel(campChannel);
      const task = (id: string, channel: ChannelId | null) =>
        sql`INSERT INTO tasks ${sql.insert({
          id,
          owner_id: agentId,
          parent_id: null,
          root_id: id,
          channel_id: channel,
          brief: "Draft it",
          state: "queued",
          created_at: now,
          updated_at: now,
        })}`;
      yield* task("in-camp", camp);
      yield* task("in-channel", channelId);
      yield* task("in-none", null);
      const ask = {
        channelIds: new Set([camp, channelId, ChannelId.make("gone")]),
        taskIds: new Set(["in-camp", "in-channel", "in-none", "gone"].map((id) => TaskId.make(id))),
      };
      const privateNow = yield* log.privacy(ask);
      const camps = yield* PrivateCamps;
      const holds = [
        yield* camps.holds({ channelId: camp }),
        yield* camps.holds({ channelId: null, taskId: TaskId.make("in-camp") }),
        yield* camps.holds({ channelId: channelId, taskId: TaskId.make("in-channel") }),
        yield* camps.holds({ channelId: null, taskId: TaskId.make("in-none") }),
      ];
      // A cursor that was not holding starts at the head, with the camps private now.
      const started = yield* log.hold;
      // Made public again: it is no longer private now, but the cursor keeps what it saved.
      yield* repo.upsertChannel(new Channel({ ...campChannel, private: false }));
      const publicAgain = yield* log.privacy(ask);
      const held = yield* log.hold;
      yield* log.save(started.sequence + 1, [], [], { privateChannels: [], excluded: [] });
      const followed = yield* log.hold;
      const none = yield* log.privacy({ channelIds: new Set(), taskIds: new Set() });
      return { privateNow, holds, started, publicAgain, held, followed, none };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    const taskChannels = new Map([
      ["in-camp", "camp"],
      ["in-channel", "t1"],
    ]);
    expect(result.privateNow).toEqual({ privateNow: new Set(["camp"]), taskChannels });
    // A turn in the camp, or on a Task of it, is in a private camp; others are not.
    expect(result.holds).toEqual([true, true, false, false]);
    expect(result.started.exclusions.privateChannels).toEqual(["camp"]);
    expect(result.publicAgain).toEqual({ privateNow: new Set(), taskChannels });
    expect(result.held.exclusions.privateChannels).toEqual(["camp"]);
    expect(result.followed.exclusions.privateChannels).toEqual([]);
    expect(result.none).toEqual({ privateNow: new Set(), taskChannels: new Map() });
  });

  // covers ADR 039 (Memory in a shared channel)
  it("keeps a channel's session open in each hob's memory, ends each on its own, and reads the messages hobs took (#1466)", async () => {
    const result = await Effect.gen(function* () {
      const log = yield* MemoryCaptureLog;
      const repo = yield* HobbotsRepository;
      yield* seed;
      const started = yield* log.hold;
      const quill = AgentId.make("quill");
      const pips = { sessionId: channelId, agentId, lastAt: now, lastKey: "entry:e1" };
      const quills = { sessionId: channelId, agentId: quill, lastAt: now, lastKey: "entry:e2" };
      yield* log.save(started.sequence, [pips, quills], [], { privateChannels: [], excluded: [] });
      const both = yield* log.hold;
      // Pip's session goes on, and only Quill's ends.
      const later = { ...pips, lastKey: "entry:e3" };
      yield* log.save(started.sequence, [later], [quills], { privateChannels: [], excluded: [] });
      const one = yield* log.hold;
      const asked = new Message({
        id: MessageId.make("m1"),
        channelId,
        actor: OWNER_ACTOR,
        role: "user",
        content: "Draft the offer letter.",
        status: "complete",
        error: null,
        configVersion: null,
        createdAt: now,
      });
      yield* repo.upsertMessage(asked);
      const read = yield* log.messages([asked.id, MessageId.make("gone")]);
      const none = yield* log.messages([]);
      return { both, one, read, none };
    }).pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

    expect(result.both.sessions).toEqual([
      { sessionId: channelId, agentId, lastAt: now, lastKey: "entry:e1" },
      { sessionId: channelId, agentId: "quill", lastAt: now, lastKey: "entry:e2" },
    ]);
    expect(result.one.sessions).toEqual([{ sessionId: channelId, agentId, lastAt: now, lastKey: "entry:e3" }]);
    expect(result.read.map((message) => [message.id, message.content, message.actor])).toEqual([
      ["m1", "Draft the offer letter.", OWNER_ACTOR],
    ]);
    expect(result.none).toEqual([]);
  });
});
