import { HobbotsRepository } from "@hobbots/agents";
import { AgentId, ChannelId, liveSession } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import hobSessionsMigration from "../src/migrations/20261114005209_hob_sessions.ts";
import { migrateAfter, TestDatabaseAt } from "../src/testing.ts";

// Issue #1464 (ADR 039): a runtime session belongs to one hob. The migration gives each session a
// channel keeps, and each session in its journaled entries, the channel's hob, so the hob goes on
// resuming it and another hob never does. On SQLite and PostgreSQL alike.

const NOW = "2026-11-13T00:00:00.000Z";
const ADA = AgentId.make("ada");
const QUILL = AgentId.make("quill");

describe("20261114005209_hob_sessions", () => {
  const earlier = Object.fromEntries(
    Object.entries(migrations).filter(([id]) => id < "20261114005209"),
  ) as typeof migrations;
  const layer = Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer).pipe(
    Layer.provideMerge(TestDatabaseAt(earlier)),
  );

  /** A channel of `agentId` with one session per runtime in its one live chapter, as stored just before this migration. */
  const stored = (channelId: string, agentId: string, runtimes: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      const chapterId = `${channelId}-c1`;
      const sessions = runtimes.map((runtime) => ({
        runtime,
        sessionId: `${channelId}-${runtime}`,
        chapterId,
        seenThrough: null,
      }));
      yield* sql`INSERT INTO threads ${sql.insert({
        id: channelId,
        agent_id: agentId,
        title: channelId,
        sessions: JSON.stringify(sessions),
        created_at: NOW,
        updated_at: NOW,
        revision: 1,
      })}`;
      yield* sql`INSERT INTO chapters ${sql.insert({
        id: chapterId,
        thread_id: channelId,
        number: 1,
        title: null,
        summary: null,
        state: "live",
        started_at: NOW,
        ended_at: null,
        moved_to: null,
        revision: 0,
      })}`;
      return {
        id: channelId,
        agentId,
        title: channelId,
        kind: "camp",
        goal: null,
        private: false,
        origin: null,
        state: "open",
        sessions,
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
    });

  const journal = (type: string, version: number, agentId: string, channelId: string, payload: object) =>
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
        agent_id: agentId,
        thread_id: channelId,
        payload: JSON.stringify({ _tag: type, ...payload }),
      })}`;
      yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
    });

  // covers ADR 039 (The context pack with several hobs), DP-003
  it("gives every stored and journaled session its channel's hob, which alone resumes it (#1464)", async () => {
    const result = await Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      for (const id of [ADA, QUILL]) {
        yield* sql`INSERT INTO agents ${sql.insert({
          id,
          name: id,
          runtime: "claude-code",
          role_title: "Guide",
          instructions: "",
          look_seed: 1,
          look_color: "moss",
          created_at: NOW,
        })}`;
      }
      const lamps = yield* stored("lamps", ADA, ["claude-code", "codex"]);
      const garden = yield* stored("garden", QUILL, ["codex"]);
      const fresh = yield* stored("fresh", QUILL, []);
      yield* stored("empty", ADA, []);
      yield* journal("ThreadUpserted", 6, ADA, "lamps", { thread: lamps });
      yield* journal("CampMade", 3, QUILL, "garden", { thread: garden });
      yield* journal("ChatStartedFresh", 3, QUILL, "fresh", { superseded: garden, chat: fresh, carried: [] });

      yield* hobSessionsMigration;
      const once = yield* sql<{ id: string; sessions: string }>`SELECT id, sessions FROM threads ORDER BY id`;
      // A second run changes nothing: every entry is at its new version, every session has its hob.
      yield* hobSessionsMigration;
      const twice = yield* sql<{ id: string; sessions: string }>`SELECT id, sessions FROM threads ORDER BY id`;
      // Today's repository and journal read them, so the rows go on to today's schema.
      yield* migrateAfter("20261114005209");

      const repo = yield* HobbotsRepository;
      return {
        once,
        twice,
        channels: yield* Effect.forEach(["lamps", "garden", "empty"], (id) =>
          repo.findChannel(ChannelId.make(id)).pipe(Effect.map(Option.getOrThrow)),
        ),
        entries: yield* (yield* EventJournal).readAfter(0),
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.twice).toEqual(result.once);
    const [lamps, garden, empty] = result.channels;
    expect(lamps?.sessions.map((s) => [s.runtime, s.agentId, s.sessionId])).toEqual([
      ["claude-code", ADA, "lamps-claude-code"],
      ["codex", ADA, "lamps-codex"],
    ]);
    expect(garden?.sessions.map((s) => [s.runtime, s.agentId, s.sessionId])).toEqual([
      ["codex", QUILL, "garden-codex"],
    ]);
    expect(empty?.sessions).toEqual([]);
    // The channel's hob resumes its sessions on both runtimes; another hob in the channel has none.
    if (lamps === undefined) throw new Error("lamps is gone");
    expect(liveSession(lamps, "claude-code", ADA)?.sessionId).toBe("lamps-claude-code");
    expect(liveSession(lamps, "codex", ADA)?.sessionId).toBe("lamps-codex");
    expect(liveSession(lamps, "claude-code", QUILL)).toBeUndefined();
    expect(liveSession(lamps, "codex", QUILL)).toBeUndefined();

    // Every old entry decodes, its sessions with their channel's hob, at its new version.
    expect(result.entries.map((e) => [e.type, e.schemaVersion])).toEqual([
      ["ChannelUpserted", 7],
      ["CampMade", 4],
      ["ChatStartedFresh", 4],
    ]);
    const hobsOf = result.entries.flatMap((e) => {
      const p = e.payload;
      if (p._tag === "ChannelUpserted" || p._tag === "CampMade") return [p.channel.sessions.map((s) => s.agentId)];
      if (p._tag === "ChatStartedFresh")
        return [p.superseded.sessions.map((s) => s.agentId), p.chat.sessions.map((s) => s.agentId)];
      return [];
    });
    expect(hobsOf).toEqual([[ADA, ADA], [QUILL], [QUILL], []]);
  });
});
