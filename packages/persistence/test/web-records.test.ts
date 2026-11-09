import { WebRecords } from "@hobbots/agents";
import {
  AgentId,
  AttemptId,
  DEFAULT_WEB_SETTINGS,
  MessageId,
  NO_HOB_WEB_LIMITS,
  QuestId,
  TaskId,
  ThreadId,
  WebFetchRecord,
  WebRecordId,
  WebSearchRecord,
} from "@hobbots/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, WebRecordsLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1269: what hobs searched and read on the web, and Settings › Web (ADR 036, Usage and limits),
// on SQLite and PostgreSQL alike.

const ada = AgentId.make("ada");
const now = "2026-11-08T12:00:00.000Z";

const storedHob = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = { roleTitle: "Guide", instructions: "", lookSeed: 1, lookColor: "moss", createdAt: now };
    yield* sql`INSERT INTO agents ${sql.insert({ id, name: id, runtime: "claude-code", ...fields })}`;
  });

const place = (id: string, messageId: string | null, at: string) => ({
  id: WebRecordId.make(id),
  agentId: ada,
  threadId: ThreadId.make("t1"),
  messageId: messageId === null ? null : MessageId.make(messageId),
  taskId: null,
  attemptId: messageId === null ? AttemptId.make("a1") : null,
  turn: messageId === null ? "attempt:a1" : `reply:${messageId}`,
  at,
});

const search = (id: string, messageId: string | null, at: string, billing: string | null) =>
  new WebSearchRecord({
    ...place(id, messageId, at),
    runtime: "claude-code",
    query: `lamps ${id}`,
    resultCount: 1,
    results: [{ title: "Lamps", url: "https://lamps.test/" }],
    billing,
  });

const page = (id: string, messageId: string, at: string) =>
  new WebFetchRecord({
    ...place(id, messageId, at),
    url: "https://lamps.test/moved",
    finalUrl: "https://lamps.test/lamp",
    status: 200,
    bytes: 1_200,
    parts: 1,
    part: 1,
    tokens: 300,
  });

describe("web records and Settings › Web", () => {
  // covers ADR 036 (Usage and limits), ADR 013
  it("[TC-PE-1269-01] records searches and pages with their journal events, and counts them per turn, hob and day", async () => {
    const read = await Effect.gen(function* () {
      yield* storedHob("ada");
      const records = yield* WebRecords;
      const entries = [
        ...(yield* records.recordSearch(search("s1", "m1", "2026-11-07T10:00:00.000Z", "subscription (Max)"))),
        ...(yield* records.recordSearch(search("s2", "m1", "2026-11-08T10:00:00.000Z", "api-key (ANTHROPIC_API_KEY)"))),
        ...(yield* records.recordSearch(search("s3", null, "2026-11-08T11:00:00.000Z", null))),
        ...(yield* records.recordFetch(page("p1", "m1", "2026-11-08T10:30:00.000Z"))),
      ];
      const journal = yield* EventJournal;
      return {
        entries,
        journaled: (yield* journal.readAfter(0, 100)).map((entry) => entry.type),
        turn: yield* records.usage({ messageId: MessageId.make("m1") }, 1),
        attempt: yield* records.usage({ attemptId: AttemptId.make("a1") }, 10),
        hob: yield* records.usage({ agentId: ada }, 10),
        today: yield* records.searchesSince(ada, "2026-11-08T00:00:00.000Z"),
      };
    }).pipe(
      Effect.provide(WebRecordsLive),
      Effect.provide(EventJournal.layer),
      Effect.provide(TestDatabase),
      Effect.runPromise,
    );

    expect(read.entries.map((entry) => entry.type)).toEqual([
      "WebSearched",
      "WebSearched",
      "WebSearched",
      "WebFetched",
    ]);
    expect(read.journaled).toEqual(["WebSearched", "WebSearched", "WebSearched", "WebFetched"]);
    expect(read.turn.count).toEqual({
      searches: 2,
      pages: 1,
      bytes: 1_200,
      tokens: 300,
      billed: [{ runtime: "claude-code", count: 1 }],
    });
    // The newest first, at most the limit, while the totals count them all.
    expect(read.turn.searches.map((each) => each.id)).toEqual(["s2"]);
    expect(read.turn.pages[0]).toEqual(page("p1", "m1", "2026-11-08T10:30:00.000Z"));
    expect(read.attempt.searches.map((each) => each.id)).toEqual(["s3"]);
    expect(read.hob.count.searches).toBe(3);
    expect(read.hob.searches[2]).toEqual(search("s1", "m1", "2026-11-07T10:00:00.000Z", "subscription (Max)"));
    expect(read.today).toBe(2);
  });

  // covers ADR 036 (Usage and limits: settings and Codex's next turn)
  it("[TC-PE-1269-02] keeps Settings › Web, a hob's own limits and a session's hold on search, which is taken once", async () => {
    const read = await Effect.gen(function* () {
      yield* storedHob("ada");
      const records = yield* WebRecords;
      const before = { settings: yield* records.settings, hob: yield* records.hobLimits(ada) };
      const settings = {
        limits: { searchesPerTurn: 3, pagesPerTurn: 5, searchesPerDay: 40 },
        blockedSites: ["example.org"],
      };
      yield* records.setSettings(settings);
      yield* records.setSettings({ ...settings, blockedSites: ["example.org", "tracker.test"] });
      yield* records.setHobLimits(ada, { searchesPerTurn: 1, pagesPerTurn: null, searchesPerDay: null });
      yield* records.holdSearch("thread:t1", "first");
      yield* records.holdSearch("thread:t1", "The last turn ran 2 web searches.");
      return {
        before,
        settings: yield* records.settings,
        hob: yield* records.hobLimits(ada),
        held: [yield* records.takeSearchHold("thread:t1"), yield* records.takeSearchHold("thread:t1")],
      };
    }).pipe(Effect.provide(WebRecordsLive), Effect.provide(TestDatabase), Effect.runPromise);

    expect(read.before).toEqual({ settings: DEFAULT_WEB_SETTINGS, hob: NO_HOB_WEB_LIMITS });
    expect(read.settings).toEqual({
      limits: { searchesPerTurn: 3, pagesPerTurn: 5, searchesPerDay: 40 },
      blockedSites: ["example.org", "tracker.test"],
    });
    expect(read.hob).toEqual({ searchesPerTurn: 1, pagesPerTurn: null, searchesPerDay: null });
    expect(read.held).toEqual(["The last turn ran 2 web searches.", null]);
  });

  // covers ADR 036 (Usage and limits: Quest counts), OR-002
  it("[TC-PE-1269-07] counts a Quest's records over its own Task and every Task under it, a nested Quest's too", async () => {
    const read = await Effect.gen(function* () {
      yield* storedHob("ada");
      const sql = yield* SqlClient.SqlClient;
      // An outer Quest on k-outer, and a Quest nested in it on k-mid; every Task keeps the outermost root.
      for (const [id, parent] of [
        ["k-outer", null],
        ["k-mid", "k-outer"],
        ["k-leaf", "k-mid"],
        ["k-side", "k-outer"],
      ] as const) {
        const fields = { owner_id: "ada", parent_id: parent, root_id: "k-outer", brief: id, state: "active" };
        yield* sql`INSERT INTO tasks ${sql.insert({ id, ...fields, created_at: now, updated_at: now })}`;
      }
      for (const [id, task, parent] of [
        ["q-outer", "k-outer", null],
        ["q-nested", "k-mid", "q-outer"],
      ] as const) {
        const fields = { lead_id: "ada", parent_quest_id: parent, goal: id, limits: "{}", state: "active" };
        yield* sql`INSERT INTO quests ${sql.insert({ id, task_id: task, ...fields, depth: parent === null ? 0 : 1, created_at: now })}`;
      }
      const records = yield* WebRecords;
      for (const [id, task] of [
        ["s-outer", "k-outer"],
        ["s-leaf", "k-leaf"],
        ["s-side", "k-side"],
      ] as const) {
        yield* records.recordSearch(new WebSearchRecord({ ...search(id, "m1", now, null), taskId: TaskId.make(task) }));
      }
      yield* records.recordFetch(new WebFetchRecord({ ...page("p-mid", "m1", now), taskId: TaskId.make("k-mid") }));
      const counted = (quest: string) =>
        records.usage({ questId: QuestId.make(quest) }, 10).pipe(
          Effect.map(({ count, searches }) => ({
            count: [count.searches, count.pages],
            searches: searches.map((each) => each.id).sort(),
          })),
        );
      return { outer: yield* counted("q-outer"), nested: yield* counted("q-nested") };
    }).pipe(
      Effect.provide(WebRecordsLive),
      Effect.provide(EventJournal.layer),
      Effect.provide(TestDatabase),
      Effect.runPromise,
    );

    expect(read.outer).toEqual({ count: [3, 1], searches: ["s-leaf", "s-outer", "s-side"] });
    // The nested Quest counts its own Task and those under it, not the sibling or the outer Task.
    expect(read.nested).toEqual({ count: [1, 1], searches: ["s-leaf"] });
  });

  // covers ADR 036 (Usage and limits: Usage's searches and pages)
  it("[TC-PE-1271-01] counts what every hob searched and read since a time, per hob and per turn, as the memory records do", async () => {
    const recorded = Effect.gen(function* () {
      const records = yield* WebRecords;
      yield* records.recordSearch(search("s0", "m0", "2026-11-01T10:00:00.000Z", null));
      yield* records.recordSearch(search("s1", "m1", "2026-11-07T10:00:00.000Z", null));
      yield* records.recordSearch(search("s2", "m1", "2026-11-08T10:00:00.000Z", "api-key (ANTHROPIC_API_KEY)"));
      yield* records.recordSearch(search("s3", null, "2026-11-08T11:00:00.000Z", null));
      yield* records.recordFetch(page("p1", "m1", "2026-11-08T10:30:00.000Z"));
      const used = yield* records.usageSince("2026-11-05T00:00:00.000Z");
      return { ...used, turns: [...used.turns].sort((a, b) => a.turn.localeCompare(b.turn)) };
    });
    const stored = await Effect.gen(function* () {
      yield* storedHob("ada");
      return yield* recorded;
    }).pipe(
      Effect.provide(WebRecordsLive),
      Effect.provide(EventJournal.layer),
      Effect.provide(TestDatabase),
      Effect.runPromise,
    );
    const inMemory = await recorded.pipe(Effect.provide(WebRecords.memory), Effect.runPromise);

    expect(stored.count.searches).toBe(3);
    expect(stored.count.pages).toBe(1);
    expect(stored.hobs).toEqual([{ agentId: ada, searches: 3, pages: 1 }]);
    expect(stored.turns).toEqual([
      {
        turn: "attempt:a1",
        agentId: ada,
        threadId: ThreadId.make("t1"),
        messageId: null,
        taskId: null,
        at: "2026-11-08T11:00:00.000Z",
        searches: 1,
        pages: 0,
      },
      {
        turn: "reply:m1",
        agentId: ada,
        threadId: ThreadId.make("t1"),
        messageId: MessageId.make("m1"),
        taskId: null,
        at: "2026-11-08T10:30:00.000Z",
        searches: 2,
        pages: 1,
      },
    ]);
    expect(inMemory).toEqual(stored);
  });
});
