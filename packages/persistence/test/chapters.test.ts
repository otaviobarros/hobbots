import { ChapterRepository, HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ChapterId,
  type ChapterRefusal,
  ChapterRefused,
  IllegalChapterTransition,
  Message,
  MessageId,
  roleFields,
  Thread,
  ThreadCheckpoint,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/sql";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChapterRepositoryLive, EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import chaptersMigration from "../src/migrations/0097_chapters.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1379 (ADR 037): a thread's transcript is split into chapters. The migration gives each
// thread one live chapter holding its history, and every message a chapter; the database keeps one
// live chapter per thread and refuses a message without one; start, split and merge keep every
// message in exactly one chapter, each journaling one event in its own transaction. On SQLite and
// PostgreSQL alike.

const NOW = "2026-11-11T00:00:00.000Z";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 0, minute)).toISOString();

const hob = (id: string) =>
  new Agent({
    id: AgentId.make(id),
    name: id,
    ...roleFields("writer"),
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });

const newThread = (id: string, agentId = "ada") =>
  new Thread({ id: ThreadId.make(id), agentId: AgentId.make(agentId), title: id, createdAt: NOW, updatedAt: NOW });

const userMessage = (threadId: string, id: string, status: Message["status"] = "complete") =>
  new Message({
    id: MessageId.make(id),
    threadId: ThreadId.make(threadId),
    role: "user",
    content: id,
    status,
    error: null,
    configVersion: null,
    createdAt: NOW,
  });

describe("0097_chapters", () => {
  const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0097")) as typeof migrations;
  const layer = Layer.mergeAll(HobbotsRepositoryLive, ChapterRepositoryLive, EventJournal.layer).pipe(
    Layer.provideMerge(TestDatabaseAt(earlier)),
  );

  /** A thread, its messages and their journal entries, as the hub stored them before 0097. */
  const stored = (threadId: string, sessions: ReadonlyArray<string>, messages: ReadonlyArray<[string, string]>) =>
    Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      const keyed = sessions.map((sessionId) => ({ runtime: "claude-code", sessionId, seenThrough: null }));
      yield* sql`INSERT INTO threads ${sql.insert({
        id: threadId,
        agent_id: "ada",
        title: threadId,
        sessions: JSON.stringify(keyed),
        created_at: at(1),
        updated_at: at(2),
        revision: 1,
      })}`;
      const [head] = yield* sql<{ sequence: unknown }>`SELECT sequence FROM event_journal_head`;
      let sequence = Number(head?.sequence);
      const journal = (type: string, version: number, payload: object) =>
        Effect.gen(function* () {
          sequence += 1;
          yield* sql`INSERT INTO event_journal ${sql.insert({
            sequence,
            id: `event-${sequence}`,
            type,
            schema_version: version,
            occurred_at: NOW,
            agent_id: "ada",
            thread_id: threadId,
            payload: JSON.stringify({ _tag: type, ...payload }),
          })}`;
          yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
        });
      const thread = {
        id: threadId,
        agentId: "ada",
        title: threadId,
        kind: "camp",
        goal: null,
        private: false,
        origin: null,
        state: "open",
        sessions: keyed,
        brain: null,
        archivedAt: null,
        lastLine: null,
        pinnedAt: null,
        unread: false,
        skillTrial: null,
        createdAt: at(1),
        updatedAt: at(2),
        revision: 1,
      };
      yield* journal("ThreadUpserted", 4, { thread });
      for (const [index, [id, status]] of messages.entries()) {
        yield* sql`INSERT INTO messages ${sql.insert({
          id,
          thread_id: threadId,
          seq: index + 1,
          role: "user",
          content: id,
          status,
          created_at: NOW,
        })}`;
        const message = {
          id,
          threadId,
          role: "user",
          content: id,
          status,
          error: null,
          configVersion: null,
          runtime: null,
          model: null,
          resetsAt: null,
          steps: [],
          createdAt: NOW,
          revision: 1,
        };
        yield* journal(status === "queued" ? "MessageQueued" : "MessageUpserted", status === "queued" ? 1 : 4, {
          message,
        });
      }
    });

  // covers ADR 037 (Chapters), DP-003
  it("[TC-DP-1379-01] gives each thread one live chapter holding its history, and every message and session its chapter", async () => {
    const result = await Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      yield* sql`INSERT INTO agents ${sql.insert({
        id: "ada",
        name: "Ada",
        runtime: "claude-code",
        role_title: "Guide",
        instructions: "",
        look_seed: 1,
        look_color: "moss",
        created_at: NOW,
      })}`;
      yield* stored(
        "lamps",
        ["s1"],
        [
          ["m1", "complete"],
          ["m2", "complete"],
          ["m3", "queued"],
        ],
      );
      yield* stored("empty", [], []);

      yield* chaptersMigration;

      const repo = yield* HobbotsRepository;
      const chapters = yield* ChapterRepository;
      const threads = yield* Effect.forEach(["lamps", "empty"], (id) =>
        repo.findThread(ThreadId.make(id)).pipe(Effect.map(Option.getOrThrow)),
      );
      return {
        threads,
        chapters: yield* Effect.forEach(threads, (thread) => chapters.listChapters(thread.id)),
        messages: yield* repo.listMessages(ThreadId.make("lamps")),
        entries: yield* (yield* EventJournal).readAfter(0),
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    const [lamps, empty] = result.chapters.map((list) => list.map((c) => ({ ...c })));
    for (const [index, list] of [lamps, empty].entries()) {
      expect(list).toEqual([
        {
          id: result.threads[index]?.liveChapterId,
          threadId: result.threads[index]?.id,
          number: 1,
          title: null,
          summary: null,
          state: "live",
          startedAt: at(1),
          endedAt: null,
          movedTo: null,
          revision: 0,
        },
      ]);
    }
    const lampsChapter = result.threads[0]?.liveChapterId;
    expect(lampsChapter).not.toBe(result.threads[1]?.liveChapterId);
    expect(result.messages.map((m) => [m.id, m.chapterId])).toEqual([
      ["m1", lampsChapter],
      ["m2", lampsChapter],
      ["m3", lampsChapter],
    ]);
    // The session the thread kept goes on being resumed, in its one chapter.
    expect(result.threads[0]?.sessions).toEqual([
      { runtime: "claude-code", sessionId: "s1", chapterId: lampsChapter, seenThrough: null },
    ]);
    // Every old entry decodes, with the chapter its thread now has, at its new version.
    expect(result.entries.map((e) => [e.type, e.schemaVersion])).toEqual([
      ["ThreadUpserted", 5],
      ["MessageUpserted", 5],
      ["MessageUpserted", 5],
      ["MessageQueued", 2],
      ["ThreadUpserted", 5],
    ]);
    const payloads = result.entries.map((e) => e.payload);
    expect(payloads.flatMap((p) => ("message" in p ? [p.message.chapterId] : []))).toEqual([
      lampsChapter,
      lampsChapter,
      lampsChapter,
    ]);
    expect(payloads.flatMap((p) => (p._tag === "ThreadUpserted" ? [p.thread.liveChapterId] : []))).toEqual(
      result.threads.map((t) => t.liveChapterId),
    );
    expect(payloads[0]?._tag === "ThreadUpserted" && payloads[0].thread.sessions[0]?.chapterId).toBe(lampsChapter);
  });
});

describe("chapters in the database", () => {
  const layer = Layer.mergeAll(HobbotsRepositoryLive, ChapterRepositoryLive, EventJournal.layer).pipe(
    Layer.provideMerge(TestDatabase),
  );

  // covers ADR 037 (Chapters), DP-003
  it("[TC-DP-1379-02] keeps one live chapter per thread and refuses a message without a chapter", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(hob("ada"));
      const thread = yield* repo.upsertThread(newThread("lamps"));
      const sql = yield* SqlClient.SqlClient;
      const secondLive = yield* Effect.exit(
        sql`INSERT INTO chapters ${sql.insert({
          id: "c2",
          threadId: "lamps",
          number: 2,
          state: "live",
          startedAt: NOW,
        })}`,
      );
      const resting = yield* Effect.exit(
        sql`INSERT INTO chapters ${sql.insert({
          id: "c3",
          threadId: "lamps",
          number: 2,
          state: "resting",
          startedAt: NOW,
        })}`,
      );
      const unknownState = yield* Effect.exit(
        sql`INSERT INTO chapters ${sql.insert({ id: "c4", threadId: "lamps", number: 3, state: "gone", startedAt: NOW })}`,
      );
      const orphan = yield* Effect.exit(
        sql`INSERT INTO messages ${sql.insert({
          id: "raw",
          threadId: "lamps",
          seq: 1,
          role: "user",
          content: "raw",
          status: "complete",
          createdAt: NOW,
        })}`,
      );
      const saved = yield* repo.upsertMessage(userMessage("lamps", "m1"));
      const cleared = yield* Effect.exit(sql`UPDATE messages SET chapter_id = NULL WHERE id = 'm1'`);
      // A thread saved again keeps its one chapter.
      yield* repo.upsertThread(new Thread({ ...thread.value, title: "Renamed" }));
      const chapters = yield* (yield* ChapterRepository).listChapters(ThreadId.make("lamps"));
      return { thread: thread.value, secondLive, resting, unknownState, orphan, saved: saved.value, cleared, chapters };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Exit.isFailure(result.secondLive)).toBe(true);
    expect(Exit.isSuccess(result.resting)).toBe(true);
    expect(Exit.isFailure(result.unknownState)).toBe(true);
    expect(Exit.isFailure(result.orphan)).toBe(true);
    expect(Exit.isFailure(result.cleared)).toBe(true);
    expect(result.saved.chapterId).toBe(result.thread.liveChapterId);
    expect(result.chapters.map((c) => [c.id, c.state])).toEqual([
      [result.thread.liveChapterId, "live"],
      ["c3", "resting"],
    ]);
  });

  // covers ADR 037 (Chapters), STD-ARCH-014
  it("[TC-DP-1379-03] changes nothing when a command is sent again, or fails midway", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const chapters = yield* ChapterRepository;
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* EventJournal;
      yield* repo.insertAgent(hob("ada"));
      yield* repo.insertAgent(hob("bo"));
      yield* repo.upsertThread(newThread("other", "bo"));
      const thread = ThreadId.make("lamps");
      yield* repo.upsertThread(newThread("lamps"));
      yield* repo.upsertMessage(userMessage("lamps", "m1"));
      const start = { id: ChapterId.make("c2"), title: "Garden", at: at(5) };
      const started = yield* chapters.startChapter(thread, start);
      const again = yield* chapters.startChapter(thread, start);
      yield* repo.upsertMessage(userMessage("lamps", "m2"));
      yield* repo.upsertMessage(userMessage("lamps", "m3"));
      const split = { id: ChapterId.make("c3"), messageId: MessageId.make("m3"), title: "Lamps" };
      yield* chapters.splitChapter(thread, split);
      const splitAgain = yield* chapters.splitChapter(thread, split);
      // Another thread already remembers a merged chapter by this id, so the merge fails at its last write.
      yield* sql`INSERT INTO merged_chapters ${sql.insert({
        id: "c3",
        threadId: "other",
        intoId: "x",
        mergedAt: NOW,
      })}`;
      const before = yield* journal.head;
      const failed = yield* Effect.exit(chapters.mergeChapters(thread, ChapterId.make("c3")));
      const afterFailure = {
        head: (yield* journal.head).sequence,
        chapters: (yield* chapters.listChapters(thread)).map((c) => [c.id, c.number, c.state]),
        messages: (yield* repo.listMessages(thread)).map((m) => [m.id, m.chapterId]),
      };
      yield* sql`DELETE FROM merged_chapters WHERE id = 'c3'`;
      const merged = yield* chapters.mergeChapters(thread, ChapterId.make("c3"));
      const mergedAgain = yield* chapters.mergeChapters(thread, ChapterId.make("c3"));
      return { started, again, splitAgain, before: before.sequence, failed, afterFailure, merged, mergedAgain };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.started.entries.map((e) => e.type)).toEqual(["ChapterStarted"]);
    expect(result.again.entries).toEqual([]);
    expect(result.again.value.chapters).toEqual(result.started.value.chapters);
    expect(result.splitAgain.entries).toEqual([]);
    expect(Exit.isFailure(result.failed)).toBe(true);
    expect(result.afterFailure).toEqual({
      head: result.before,
      chapters: [
        [result.started.value.chapters[0]?.id, 1, "resting"],
        ["c2", 2, "resting"],
        ["c3", 3, "live"],
      ],
      messages: [
        ["m1", result.started.value.chapters[0]?.id],
        ["m2", "c2"],
        ["m3", "c3"],
      ],
    });
    expect(result.merged.entries.map((e) => e.type)).toEqual(["ChapterMerged"]);
    expect(result.merged.value.chapters.map((c) => [c.id, c.number, c.state])).toEqual([
      [result.started.value.chapters[0]?.id, 1, "resting"],
      ["c2", 2, "live"],
    ]);
    expect(result.mergedAgain.entries).toEqual([]);
  });

  // The model-based test: random messages, starts, splits and merges on a thread, against a model
  // that keeps each chapter's messages in order.
  type Op =
    | { readonly _tag: "Say" }
    | { readonly _tag: "Start"; readonly title: string }
    | { readonly _tag: "Split"; readonly at: number }
    | { readonly _tag: "Merge"; readonly at: number };

  interface ModelChapter {
    readonly id: string;
    readonly messages: ReadonlyArray<string>;
  }

  const ops: fc.Arbitrary<Op> = fc.oneof(
    { weight: 3, arbitrary: fc.constant({ _tag: "Say" as const }) },
    { weight: 1, arbitrary: fc.constantFrom("Garden", " ").map((title) => ({ _tag: "Start" as const, title })) },
    { weight: 2, arbitrary: fc.nat(30).map((at) => ({ _tag: "Split" as const, at })) },
    { weight: 2, arbitrary: fc.nat(8).map((at) => ({ _tag: "Merge" as const, at })) },
  );

  /** What the model says an op does: the chapters after it, or the refusal it expects. */
  const modelStep = (chapters: ReadonlyArray<ModelChapter>, op: Op, made: string, message: string) => {
    const live = chapters.length - 1;
    switch (op._tag) {
      case "Say":
        return chapters.map((c, i) => (i === live ? { ...c, messages: [...c.messages, message] } : c));
      case "Start":
        if (op.title.trim() === "") return "empty-title" as const;
        if ((chapters[live]?.messages.length ?? 0) === 0) return "live-chapter-empty" as const;
        return [...chapters, { id: made, messages: [] }];
      case "Split": {
        const all = chapters.flatMap((c, index) => c.messages.map((m, place) => ({ m, index, place })));
        const point = all[op.at];
        if (point === undefined) return "message-not-found" as const;
        if (point.place === 0) return "chapter-start" as const;
        const from = chapters[point.index] as ModelChapter;
        return [
          ...chapters.slice(0, point.index),
          { ...from, messages: from.messages.slice(0, point.place) },
          { id: made, messages: from.messages.slice(point.place) },
          ...chapters.slice(point.index + 1),
        ];
      }
      case "Merge": {
        if (op.at >= chapters.length) return "not-found" as const;
        if (op.at === 0) return "first-chapter" as const;
        const into = chapters[op.at - 1] as ModelChapter;
        const absorbed = chapters[op.at] as ModelChapter;
        return [
          ...chapters.slice(0, op.at - 1),
          { ...into, messages: [...into.messages, ...absorbed.messages] },
          ...chapters.slice(op.at + 1),
        ];
      }
    }
  };

  /** Runs an op on the thread: a message of yours, or a chapter command. */
  const perform = (op: Op, threadId: ThreadId, made: string, message: string, step: number) =>
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const store = yield* ChapterRepository;
      const id = ChapterId.make(made);
      switch (op._tag) {
        case "Say":
          return (yield* repo.upsertMessage(userMessage(threadId, message))).entries;
        case "Start":
          return (yield* store.startChapter(threadId, { id, title: op.title, at: at(step) })).entries;
        case "Split": {
          const point = (yield* repo.listMessages(threadId))[op.at]?.id ?? MessageId.make("missing");
          return (yield* store.splitChapter(threadId, { id, messageId: point, title: "Split" })).entries;
        }
        case "Merge": {
          const chapter = (yield* store.listChapters(threadId))[op.at];
          return (yield* store.mergeChapters(threadId, chapter?.id ?? ChapterId.make("missing"))).entries;
        }
      }
    });

  const EVENT_OF = { Start: "ChapterStarted", Split: "ChapterSplit", Merge: "ChapterMerged" } as const;

  let hub: ManagedRuntime.ManagedRuntime<Layer.Success<typeof layer>, Layer.Error<typeof layer>>;
  beforeAll(async () => {
    hub = ManagedRuntime.make(layer);
    await hub.runPromise(HobbotsRepository.use((repo) => repo.insertAgent(hob("ada"))));
  });
  afterAll(() => hub.dispose());

  // covers ADR 037 (Chapters), STD-ARCH-013, STD-ARCH-015
  it("[TC-DP-1379-04] keeps every message in exactly one chapter through random starts, splits and merges", async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(ops, { minLength: 1, maxLength: 25 }), (script) =>
        hub.runPromise(
          Effect.gen(function* () {
            runs += 1;
            const repo = yield* HobbotsRepository;
            const store = yield* ChapterRepository;
            const threadId = ThreadId.make(`t${runs}`);
            const thread = (yield* repo.upsertThread(newThread(threadId))).value;
            let model: ReadonlyArray<ModelChapter> = [{ id: thread.liveChapterId as string, messages: [] }];
            for (const [step, op] of script.entries()) {
              const made = `t${runs}-c${step}`;
              const message = `t${runs}-m${step}`;
              const expected = modelStep(model, op, made, message);
              const outcome = yield* Effect.exit(perform(op, threadId, made, message, step));
              const where = `step ${step} of ${JSON.stringify(script)}`;
              if (typeof expected === "string") {
                expect(Exit.isFailure(outcome), where).toBe(true);
                if (Exit.isFailure(outcome) && expected !== "not-found") {
                  const error = outcome.cause.reasons.find((reason) => reason._tag === "Fail");
                  const failure = error?._tag === "Fail" ? error.error : undefined;
                  expect(failure instanceof ChapterRefused ? failure.reason : failure, where).toBe(
                    expected satisfies ChapterRefusal,
                  );
                }
              } else {
                expect(Exit.isSuccess(outcome), where).toBe(true);
                if (Exit.isSuccess(outcome)) {
                  // Each command journals exactly its one event.
                  const types = outcome.value.map((e) => e.type);
                  if (op._tag !== "Say") expect(types, where).toEqual([EVENT_OF[op._tag]]);
                }
                model = expected;
              }
              const chapters = yield* store.listChapters(threadId);
              const messages = yield* repo.listMessages(threadId);
              expect(
                chapters.map((c) => [c.id, c.number, c.state]),
                where,
              ).toEqual(model.map((c, index) => [c.id, index + 1, index === model.length - 1 ? "live" : "resting"]));
              expect(
                messages.map((m) => [m.id, m.chapterId]),
                where,
              ).toEqual(model.flatMap((c) => c.messages.map((m) => [m, c.id])));
              const stored = Option.getOrThrow(yield* repo.findThread(threadId));
              expect(stored.liveChapterId, where).toBe(model.at(-1)?.id);
            }
          }),
        ),
      ),
      { numRuns: 40 },
    );
  });

  // covers ADR 037 (Chapters)
  it("[TC-DP-1379-05] refuses a move a chapter's state does not allow, and journals nothing", async () => {
    const result = await hub.runPromise(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const store = yield* ChapterRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("moved");
        yield* repo.upsertThread(newThread(threadId));
        yield* repo.upsertMessage(userMessage(threadId, "moved-m1"));
        yield* store.startChapter(threadId, { id: ChapterId.make("moved-c2"), title: "Next", at: at(1) });
        // A chapter that moved into a camp (#1364) takes nothing in.
        yield* repo.upsertThread(newThread("camp"));
        yield* sql`UPDATE chapters SET state = 'moved', moved_to = 'camp' WHERE thread_id = 'moved' AND number = 1`;
        const head = (yield* (yield* EventJournal).head).sequence;
        const refused = yield* Effect.exit(store.mergeChapters(threadId, ChapterId.make("moved-c2")));
        return { refused, head, after: (yield* (yield* EventJournal).head).sequence };
      }),
    );
    expect(Exit.isFailure(result.refused)).toBe(true);
    if (Exit.isFailure(result.refused)) {
      const reason = result.refused.cause.reasons.find((r) => r._tag === "Fail");
      expect(reason?._tag === "Fail" && reason.error).toBeInstanceOf(IllegalChapterTransition);
    }
    expect(result.after).toBe(result.head);
  });

  // covers ADR 037 (Chapters), ADR 017, CH-004, DP-001, STD-ARCH-018
  it("[TC-DP-1379-06] versions the messages a split or merge moves, and forgets what the old boundaries gave", async () => {
    const result = await hub.runPromise(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const store = yield* ChapterRepository;
        const threadId = ThreadId.make("versions");
        yield* repo.upsertThread(newThread(threadId));
        const reply = (id: string) =>
          new Message({ ...userMessage(threadId, id), role: "assistant", content: `Reply ${id}` });
        for (const message of [userMessage(threadId, "v1"), reply("v2"), userMessage(threadId, "v3"), reply("v4")])
          yield* repo.upsertMessage(message);
        const stored = Option.getOrThrow(yield* repo.findThread(threadId));
        const first = stored.liveChapterId as ChapterId;
        yield* repo.upsertThread(
          new Thread({
            ...stored,
            sessions: [
              { runtime: "claude-code", sessionId: "s1", chapterId: first, seenThrough: MessageId.make("v4") },
            ],
          }),
        );
        yield* repo.markThreadRead(threadId, MessageId.make("v4"), Number.MAX_SAFE_INTEGER);
        const checkpoint = new ThreadCheckpoint({
          threadId,
          throughMessageId: MessageId.make("v4"),
          lines: ["- User: “v1”"],
          omitted: 0,
          createdAt: NOW,
        });
        yield* repo.saveCheckpoint(checkpoint);
        const revisions = () =>
          repo.listMessages(threadId).pipe(Effect.map((all) => all.map((m) => [m.id, m.chapterId, m.revision])));
        const before = yield* revisions();

        const split = yield* store.splitChapter(threadId, {
          id: ChapterId.make("versions-c2"),
          messageId: MessageId.make("v3"),
          title: "Later",
        });
        const afterSplit = {
          messages: yield* revisions(),
          thread: Option.getOrThrow(yield* repo.findThread(threadId)),
          checkpoint: yield* repo.findCheckpoint(threadId),
        };
        yield* repo.saveCheckpoint(checkpoint);
        const merged = yield* store.mergeChapters(threadId, ChapterId.make("versions-c2"));
        const afterMerge = {
          messages: yield* revisions(),
          thread: Option.getOrThrow(yield* repo.findThread(threadId)),
          checkpoint: yield* repo.findCheckpoint(threadId),
        };
        return { first, before, split, afterSplit, merged, afterMerge };
      }),
    );
    const splitAt = result.split.entries[0]?.sequence;
    const mergedAt = result.merged.entries[0]?.sequence;
    const [v1, v2] = result.before;
    // A client holding an earlier version of a moved message takes the moved one, which is newer.
    expect(result.afterSplit.messages).toEqual([
      v1,
      v2,
      ["v3", "versions-c2", splitAt],
      ["v4", "versions-c2", splitAt],
    ]);
    expect(result.afterMerge.messages).toEqual([
      v1,
      v2,
      ["v3", result.first, mergedAt],
      ["v4", result.first, mergedAt],
    ]);
    // A thread you had read stays read, and the briefing summary of the old boundaries is gone.
    expect([result.afterSplit.thread.unread, result.afterMerge.thread.unread]).toEqual([false, false]);
    expect([Option.isNone(result.afterSplit.checkpoint), Option.isNone(result.afterMerge.checkpoint)]).toEqual([
      true,
      true,
    ]);
    // A split leaves the first chapter's session, which is resting; the merge makes it live again
    // and drops it, so it is never resumed.
    expect(result.afterSplit.thread.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(result.afterMerge.thread).toMatchObject({ liveChapterId: result.first, liveChapterMerges: 1, sessions: [] });
  });
});
