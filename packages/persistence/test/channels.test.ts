import { HobbotsRepository } from "@hobbots/agents";
import { AgentId, ChannelId, EVENT_SCHEMA_VERSIONS, OWNER_ACTOR } from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import channelsMigration, { channelWord, renamedJson } from "../src/migrations/20261115225102_channels.ts";
import { TestDatabaseAt } from "../src/testing.ts";

// Issue #1610: the code's Thread is now a Channel, a hob's one chat its `direct` channel and the
// channel's hob its owner. The migration renames the tables, columns, indexes and every stored and
// journaled name, so a hub from before boots and reads all it kept, on SQLite and PostgreSQL alike.

const NOW = "2026-11-15T00:00:00.000Z";
const ADA = "ada";

describe("channelWord", () => {
  it("renames thread in every case and inside other words, and nothing else", () => {
    expect(
      ["thread", "threads", "Thread", "THREAD", "threadId", "thread_members", "ThreadUpserted", "camp"].map(
        channelWord,
      ),
    ).toEqual(["channel", "channels", "Channel", "CHANNEL", "channelId", "channel_members", "ChannelUpserted", "camp"]);
  });

  it("renames keys and tags but keeps every other value, and names a stored channel's hob its owner", () => {
    expect(
      renamedJson({
        _tag: "ThreadUpserted",
        thread: { id: "t1", agentId: ADA, title: "Lamps", kind: "chat", createdAt: NOW, updatedAt: NOW },
        threadId: "t1",
        text: "a thread about thread:t1",
      }),
    ).toEqual({
      _tag: "ChannelUpserted",
      channel: { id: "t1", ownerHobId: ADA, title: "Lamps", kind: "direct", createdAt: NOW, updatedAt: NOW },
      channelId: "t1",
      text: "a thread about thread:t1",
    });
  });
});

describe("20261115225102_channels", () => {
  const earlier = Object.fromEntries(
    Object.entries(migrations).filter(([id]) => id < "20261115225102"),
  ) as typeof migrations;
  const layer = Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer).pipe(
    Layer.provideMerge(TestDatabaseAt(earlier)),
  );

  /** A channel of Ada's, its live chapter, its two members and one message, as stored just before the rename. */
  const stored = (id: string, kind: "chat" | "camp") =>
    Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      const chapterId = `${id}-c1`;
      yield* sql`INSERT INTO threads ${sql.insert({
        id,
        agent_id: ADA,
        title: id,
        kind,
        state: "open",
        sessions: "[]",
        created_at: NOW,
        updated_at: NOW,
        revision: 1,
      })}`;
      yield* sql`INSERT INTO chapters ${sql.insert({ id: chapterId, thread_id: id, number: 1, state: "live", started_at: NOW })}`;
      for (const [actorKind, actorId, role] of [
        ["user", "owner", "owner"],
        ["hob", ADA, "member"],
      ]) {
        yield* sql`INSERT INTO thread_members ${sql.insert({
          thread_id: id,
          actor_kind: actorKind,
          actor_id: actorId,
          role,
          state: "active",
          joined_at: NOW,
          added_by_kind: "user",
          added_by_id: "owner",
          revision: 1,
        })}`;
      }
      yield* sql`INSERT INTO messages ${sql.insert({
        id: `${id}-m1`,
        thread_id: id,
        chapter_id: chapterId,
        actor_kind: "user",
        actor_id: "owner",
        seq: 1,
        role: "user",
        content: "Light the lamps",
        status: "complete",
        created_at: NOW,
      })}`;
      const thread = {
        id,
        agentId: ADA,
        title: id,
        kind,
        goal: null,
        private: false,
        origin: null,
        state: "open",
        sessions: [],
        brain: null,
        archivedAt: null,
        lastLine: null,
        pinnedAt: null,
        skillTrial: null,
        liveChapterId: chapterId,
        createdAt: NOW,
        updatedAt: NOW,
        revision: 1,
      };
      const member = {
        threadId: id,
        actor: { kind: "hob", id: ADA },
        role: "member",
        state: "active",
        joinedAt: NOW,
        addedBy: OWNER_ACTOR,
        readRevision: null,
        mutedUntil: null,
        revision: 1,
      };
      const message = {
        id: `${id}-m1`,
        threadId: id,
        chapterId,
        actor: OWNER_ACTOR,
        role: "user",
        content: "Light the lamps",
        status: "complete",
        error: null,
        configVersion: null,
        createdAt: NOW,
        revision: 1,
      };
      yield* journal("ThreadUpserted", 7, id, { thread });
      yield* journal("ThreadMemberAdded", 1, id, { member });
      yield* journal("MessageUpserted", 6, id, { message });
    });

  const journal = (type: string, version: number, threadId: string, payload: object) =>
    Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      const [head] = yield* sql<{ sequence: unknown }>`SELECT sequence FROM event_journal_head`;
      const sequence = Number(head?.sequence) + 1;
      yield* sql`INSERT INTO event_journal ${sql.insert({
        sequence,
        id: `event-${sequence}`,
        type,
        schema_version: version,
        occurred_at: NOW,
        agent_id: ADA,
        thread_id: threadId,
        payload: JSON.stringify({ _tag: type, ...payload }),
      })}`;
      yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
    });

  // covers DP-003
  it("keeps every stored channel, member, message and journaled entry readable under its new names (#1610)", async () => {
    const result = await Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      yield* sql`INSERT INTO agents ${sql.insert({
        id: ADA,
        name: "Ada",
        runtime: "claude-code",
        role_title: "Guide",
        instructions: "",
        look_seed: 1,
        look_color: "moss",
        created_at: NOW,
      })}`;
      yield* stored("lamps", "chat");
      yield* stored("garden", "camp");

      yield* channelsMigration;
      const repo = yield* HobbotsRepository;
      const channels = yield* Effect.forEach(["lamps", "garden"], (id) =>
        repo.findChannel(ChannelId.make(id)).pipe(Effect.map(Option.getOrThrow)),
      );
      const second = yield* Effect.exit(
        sql`INSERT INTO channels ${sql.insert({
          id: "second",
          agent_id: ADA,
          title: "Second",
          kind: "direct",
          state: "open",
          created_at: NOW,
          updated_at: NOW,
          revision: 1,
        })}`,
      );
      const tables = yield* sql.onDialectOrElse({
        pg: () => sql<{ name: string }>`SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = current_schema()`,
        orElse: () => sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`,
      });
      return {
        channels,
        messages: yield* repo.listMessages(ChannelId.make("lamps")),
        entries: yield* (yield* EventJournal).readAfter(0),
        second,
        tables: tables.map((row) => row.name),
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.channels.map((c) => [c.id, c.kind, c.ownerHobId, c.liveChapterId])).toEqual([
      ["lamps", "direct", AgentId.make(ADA), "lamps-c1"],
      ["garden", "camp", AgentId.make(ADA), "garden-c1"],
    ]);
    expect(result.messages.map((m) => [m.id, m.channelId, m.chapterId])).toEqual([["lamps-m1", "lamps", "lamps-c1"]]);
    // The database still keeps one open direct channel per hob.
    expect(Exit.isFailure(result.second)).toBe(true);
    expect(result.tables.filter((name) => /thread/i.test(name))).toEqual([]);

    // Every entry decodes, under its new name, at its version.
    expect(result.entries.map((e) => [e.type, e.correlation.channelId, e.schemaVersion])).toEqual(
      ["lamps", "garden"].flatMap((id) => [
        ["ChannelUpserted", id, EVENT_SCHEMA_VERSIONS.ChannelUpserted],
        ["ChannelMemberAdded", id, EVENT_SCHEMA_VERSIONS.ChannelMemberAdded],
        ["MessageUpserted", id, EVENT_SCHEMA_VERSIONS.MessageUpserted],
      ]),
    );
    const owners = result.entries.flatMap((e) =>
      e.payload._tag === "ChannelUpserted" ? [[e.payload.channel.kind, e.payload.channel.ownerHobId]] : [],
    );
    expect(owners).toEqual([
      ["direct", ADA],
      ["camp", ADA],
    ]);
    const members = result.entries.flatMap((e) =>
      e.payload._tag === "ChannelMemberAdded" ? [e.payload.member.channelId] : [],
    );
    expect(members).toEqual(["lamps", "garden"]);
  });
});
