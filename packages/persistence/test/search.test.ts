import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HobbotsRepository } from "@hobbots/agents";
import { Agent, AgentId, type AgentStatus, Message, MessageId, Thread, ThreadId } from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations, SearchIndex, SqliteLive } from "../src/index.ts";
import searchIndex from "../src/migrations/0011_search_index.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

const now = "2026-10-28T00:00:00.000Z";

const hob = (id: string, status: AgentStatus = "active") =>
  new Agent({
    id: AgentId.make(id),
    name: id,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    status,
    createdAt: now,
  });

const thread = (id: string, agentId: string, title: string, updatedAt = now) =>
  new Thread({
    id: ThreadId.make(id),
    agentId: AgentId.make(agentId),
    title,
    runtimeSessionId: null,
    createdAt: now,
    updatedAt,
  });

const message = (id: string, threadId: string, content: string, status: Message["status"] = "complete") =>
  new Message({
    id: MessageId.make(id),
    threadId: ThreadId.make(threadId),
    role: "assistant",
    content,
    status,
    error: null,
    configVersion: 1,
    createdAt: now,
  });

/** A hob with an old thread about the garden, a newer one about taxes, and a retired hob's thread. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(hob("pip"));
  yield* repo.insertAgent(hob("old", "retired"));
  yield* repo.upsertThread(thread("garden", "pip", "Plan the garden", "2026-10-01T00:00:00.000Z"));
  yield* repo.upsertThread(thread("taxes", "pip", "Taxes for 2026", "2026-10-20T00:00:00.000Z"));
  yield* repo.upsertThread(thread("gone", "old", "Retired chat"));
  yield* repo.upsertMessage(message("g1", "garden", "Plant the tomatoes in late spring."));
  yield* repo.upsertMessage(message("g2", "garden", "Water the TOMATOES every morning, near the fence."));
  yield* repo.upsertMessage(message("t1", "taxes", "Gather the receipts for the fence repair."));
  yield* repo.upsertMessage(message("x1", "gone", "Tomatoes from a retired hob."));
});

const Layers = Layer.mergeAll(HobbotsRepositoryLive, SearchIndex.layer).pipe(Layer.provideMerge(TestDatabase));

const ids = (hits: ReadonlyArray<{ thread: Thread; matches: ReadonlyArray<{ messageId: string }> }>) =>
  hits.map((hit) => [hit.thread.id, hit.matches.map((m) => m.messageId)]);

describe("SearchIndex", () => {
  // covers CH-006
  it("[TC-CH-060] finds threads by a word from their title or messages, newest thread first", async () => {
    const result = await Effect.gen(function* () {
      yield* seed;
      const index = yield* SearchIndex;
      return {
        word: yield* index.search("tomatoes"),
        prefix: yield* index.search("tomat"),
        title: yield* index.search("garden"),
        both: yield* index.search("fence"),
        every: yield* index.search("fence receipts"),
        none: yield* index.search("zebra"),
        blank: yield* index.search("  ¿? "),
      };
    }).pipe(Effect.provide(Layers), Effect.runPromise);

    // Case does not matter, the retired hob's thread is left out, and the newest match comes first.
    expect(ids(result.word)).toEqual([["garden", ["g2", "g1"]]]);
    expect(ids(result.prefix)).toEqual([["garden", ["g2", "g1"]]]);
    expect(result.word[0]).toMatchObject({ titleMatch: false, matchCount: 2 });
    expect(result.title.map((hit) => [hit.thread.id, hit.titleMatch, hit.matches.length])).toEqual([
      ["garden", true, 0],
    ]);
    expect(ids(result.both)).toEqual([
      ["taxes", ["t1"]],
      ["garden", ["g2"]],
    ]);
    expect(ids(result.every)).toEqual([["taxes", ["t1"]]]);
    expect(result.none).toEqual([]);
    expect(result.blank).toEqual([]);
    expect(result.word[0]?.matches[0]?.snippet).toEqual([
      { text: "Water the ", match: false },
      { text: "TOMATOES", match: true },
      { text: " every morning, near the fence.", match: false },
    ]);
  });

  // covers CH-006
  it("[TC-CH-061] indexes a reply once it finishes and follows its later changes", async () => {
    const result = await Effect.gen(function* () {
      yield* seed;
      const repo = yield* HobbotsRepository;
      const index = yield* SearchIndex;
      yield* repo.upsertMessage(message("t2", "taxes", "Draft about pumpkins", "streaming"));
      const streaming = yield* index.search("pumpkins");
      yield* repo.upsertMessage(message("t2", "taxes", "Draft about pumpkins and squash", "complete"));
      const finished = yield* index.search("squash");
      yield* repo.upsertMessage(message("t2", "taxes", "Only squash now", "complete"));
      yield* repo.upsertThread(thread("taxes", "pip", "Renamed ledger", "2026-10-20T00:00:00.000Z"));
      return {
        streaming,
        finished,
        oldWord: yield* index.search("pumpkins"),
        newWord: yield* index.search("only squash"),
        oldTitle: yield* index.search("taxes"),
        newTitle: yield* index.search("ledger"),
      };
    }).pipe(Effect.provide(Layers), Effect.runPromise);

    expect(result.streaming).toEqual([]);
    expect(ids(result.finished)).toEqual([["taxes", ["t2"]]]);
    expect(result.oldWord).toEqual([]);
    expect(ids(result.newWord)).toEqual([["taxes", ["t2"]]]);
    expect(result.oldTitle).toEqual([]);
    expect(result.newTitle.map((hit) => hit.thread.id)).toEqual(["taxes"]);
  });

  // covers CH-006
  it("[TC-CH-067] a thread with hundreds of matches leaves room for another thread's old match", async () => {
    const result = await Effect.gen(function* () {
      yield* seed;
      const repo = yield* HobbotsRepository;
      yield* repo.upsertThread(thread("busy", "pip", "Busy chat", "2026-10-25T00:00:00.000Z"));
      for (let n = 0; n < 320; n++) yield* repo.upsertMessage(message(`b${n}`, "busy", `Fence note ${n}`));
      return yield* (yield* SearchIndex).search("fence");
    }).pipe(Effect.provide(Layers), Effect.runPromise);

    expect(result.map((hit) => [hit.thread.id, hit.matchCount, hit.matches.length])).toEqual([
      ["busy", 320, 3],
      ["taxes", 1, 1],
      ["garden", 1, 1],
    ]);
    expect(result[0]?.matches.map((m) => m.messageId)).toEqual(["b319", "b318", "b317"]);
  });

  // covers CH-006
  it("[TC-CH-068] the exact accented word finds an accented message", async () => {
    const result = await Effect.gen(function* () {
      yield* seed;
      yield* (yield* HobbotsRepository).upsertMessage(message("t3", "taxes", "Receipts from the Café"));
      const index = yield* SearchIndex;
      return { exact: yield* index.search("Café"), prefix: yield* index.search("caf") };
    }).pipe(Effect.provide(Layers), Effect.runPromise);

    expect(ids(result.exact)).toEqual([["taxes", ["t3"]]]);
    expect(ids(result.prefix)).toEqual([["taxes", ["t3"]]]);
  });

  // covers CH-006, CH-008
  it("[TC-CH-070] a queued message joins the index when its turn starts, and a stopped reply when it stops", async () => {
    const queued = (id: string, content: string) =>
      new Message({ ...message(id, "taxes", content, "queued"), role: "user" });
    const result = await Effect.gen(function* () {
      yield* seed;
      const repo = yield* HobbotsRepository;
      const index = yield* SearchIndex;
      yield* repo.upsertMessage(queued("q1", "Ask about walnuts"));
      yield* repo.upsertMessage(queued("q2", "Ask about walnuts again"));
      const whileQueued = yield* index.search("walnuts");
      // Starting the first saves it and its streaming reply in one transaction; removing the second deletes it.
      yield* repo.startQueuedMessage(
        new Message({ ...queued("q1", "Ask about walnuts"), status: "complete" }),
        message("r1", "taxes", "Walnuts keep", "streaming"),
      );
      yield* repo.removeQueuedMessage(ThreadId.make("taxes"), MessageId.make("q2"));
      const started = yield* index.search("walnuts");
      yield* repo.upsertMessage(message("r1", "taxes", "Walnuts keep for months", "stopping"));
      const stopping = yield* index.search("months");
      yield* repo.upsertMessage(message("r1", "taxes", "Walnuts keep for months", "stopped"));
      // Removing a message the index never held must not touch the index; SQLite's check fails if it did.
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => Effect.void,
        orElse: () => sql`INSERT INTO messages_search (messages_search, rank) VALUES ('integrity-check', 1)`,
      });
      return { whileQueued, started, stopping, stopped: yield* index.search("walnuts") };
    }).pipe(Effect.provide(Layers), Effect.runPromise);

    expect(result.whileQueued).toEqual([]);
    expect(ids(result.started)).toEqual([["taxes", ["q1"]]]);
    expect(result.stopping).toEqual([]);
    expect(result.stopped[0]?.matches.map((m) => m.messageId).sort()).toEqual(["q1", "r1"]);
    expect(result.stopped[0]?.matchCount).toBe(2);
  });

  // covers CH-006, DP-003
  it("[TC-CH-062] finds threads and messages written before the index existed", async () => {
    const before = Object.fromEntries(
      Object.entries(migrations).filter(([key]) => key !== "0011_search_index"),
    ) as typeof migrations;
    const result = await Effect.gen(function* () {
      yield* seed;
      yield* searchIndex;
      const index = yield* SearchIndex;
      return { message: yield* index.search("receipts"), title: yield* index.search("plan garden") };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(HobbotsRepositoryLive, SearchIndex.layer).pipe(Layer.provideMerge(TestDatabaseAt(before))),
      ),
      Effect.runPromise,
    );

    expect(ids(result.message)).toEqual([["taxes", ["t1"]]]);
    expect(result.title.map((hit) => hit.thread.id)).toEqual(["garden"]);
  });

  // covers CH-006
  it("[TC-CH-063] searches a SQLite file from a worker thread that sees the server's writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hobbots-search-"));
    try {
      const filename = join(dir, "hobbots.sqlite");
      const result = await Effect.gen(function* () {
        yield* seed;
        const index = yield* SearchIndex;
        const first = yield* index.search("tomatoes");
        // A write after the worker started is visible to the next search.
        yield* (yield* HobbotsRepository).upsertMessage(message("t3", "taxes", "Café receipts"));
        return { first, later: yield* index.search("cafe") };
      }).pipe(
        Effect.provide(
          SearchIndex.sqliteWorker(filename).pipe(
            Layer.merge(HobbotsRepositoryLive),
            Layer.provideMerge(SqliteLive(filename)),
          ),
        ),
        Effect.runPromise,
      );

      expect(ids(result.first)).toEqual([["garden", ["g2", "g1"]]]);
      // SQLite's index ignores accents.
      expect(ids(result.later)).toEqual([["taxes", ["t3"]]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
