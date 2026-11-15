import { ChapterRepository, HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ChapterId,
  type ChapterRefusal,
  ChapterRefused,
  IllegalChapterTransition,
  liveSession,
  Message,
  MessageId,
  OWNER_ACTOR,
  roleFields,
  Channel,
  ChannelCheckpoint,
  ChannelId,
} from "@hobbots/domain";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/sql";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChapterRepositoryLive, EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import chaptersMigration from "../src/migrations/0099_chapters.ts";
import recordsMigration from "../src/migrations/0101_records.ts";
import hobSessionsMigration from "../src/migrations/20261114005209_hob_sessions.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1379 (ADR 037): a channel's transcript is split into chapters. The migration gives each
// channel one live chapter holding its history, and every message a chapter; the database keeps one
// live chapter per channel and refuses a message without one; start, split and merge keep every
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

const newChannel = (id: string, agentId = "ada") =>
  new Channel({ id: ChannelId.make(id), ownerHobId: AgentId.make(agentId), title: id, createdAt: NOW, updatedAt: NOW });

const userMessage = (channelId: string, id: string, status: Message["status"] = "complete") =>
  new Message({
    id: MessageId.make(id),
    channelId: ChannelId.make(channelId),
    actor: OWNER_ACTOR,
    role: "user",
    content: id,
    status,
    error: null,
    configVersion: null,
    createdAt: NOW,
  });

describe("0099_chapters", () => {
  const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0099")) as typeof migrations;
  const layer = Layer.mergeAll(HobbotsRepositoryLive, ChapterRepositoryLive, EventJournal.layer).pipe(
    Layer.provideMerge(TestDatabaseAt(earlier)),
  );

  /** A channel, its messages and their journal entries, as the hub stored them before 0099. */
  const stored = (channelId: string, sessions: ReadonlyArray<string>, messages: ReadonlyArray<[string, string]>) =>
    Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      const keyed = sessions.map((sessionId) => ({ runtime: "claude-code", sessionId, seenThrough: null }));
      yield* sql`INSERT INTO channels ${sql.insert({
        id: channelId,
        agent_id: "ada",
        title: channelId,
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
            channel_id: channelId,
            payload: JSON.stringify({ _tag: type, ...payload }),
          })}`;
          yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
        });
      const channel = {
        id: channelId,
        agentId: "ada",
        title: channelId,
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
      yield* journal("ChannelUpserted", 4, { channel });
      for (const [index, [id, status]] of messages.entries()) {
        yield* sql`INSERT INTO messages ${sql.insert({
          id,
          channel_id: channelId,
          seq: index + 1,
          role: "user",
          content: id,
          status,
          created_at: NOW,
        })}`;
        const message = {
          id,
          channelId,
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
  it("gives each channel one live chapter holding its history, and every message and session its chapter (#1379)", async () => {
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
      // Sessions now also name their hob (20261114005209_hob_sessions), which the hub reads them with.
      yield* hobSessionsMigration;
      // The entries as 0099 left them, before 0101 names every message's author, which the hub reads
      // a channel's last line with.
      const entries = yield* (yield* EventJournal).readAfter(0);
      yield* recordsMigration;

      const repo = yield* HobbotsRepository;
      const chapters = yield* ChapterRepository;
      const channels = yield* Effect.forEach(["lamps", "empty"], (id) =>
        repo.findChannel(ChannelId.make(id)).pipe(Effect.map(Option.getOrThrow)),
      );
      return {
        channels,
        chapters: yield* Effect.forEach(channels, (channel) => chapters.listChapters(channel.id)),
        messages: yield* repo.listMessages(ChannelId.make("lamps")),
        entries,
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    const [lamps, empty] = result.chapters.map((list) => list.map((c) => ({ ...c })));
    for (const [index, list] of [lamps, empty].entries()) {
      expect(list).toEqual([
        {
          id: result.channels[index]?.liveChapterId,
          channelId: result.channels[index]?.id,
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
    const lampsChapter = result.channels[0]?.liveChapterId;
    expect(lampsChapter).not.toBe(result.channels[1]?.liveChapterId);
    expect(result.messages.map((m) => [m.id, m.chapterId])).toEqual([
      ["m1", lampsChapter],
      ["m2", lampsChapter],
      ["m3", lampsChapter],
    ]);
    // The session the channel kept goes on being resumed, in its one chapter.
    expect(result.channels[0]?.sessions).toEqual([
      { runtime: "claude-code", agentId: "ada", sessionId: "s1", chapterId: lampsChapter, seenThrough: null },
    ]);
    // Every old entry decodes, with the chapter its channel now has, at its new version.
    expect(result.entries.map((e) => [e.type, e.schemaVersion])).toEqual([
      ["ChannelUpserted", 7],
      ["MessageUpserted", 5],
      ["MessageUpserted", 5],
      ["MessageQueued", 2],
      ["ChannelUpserted", 7],
    ]);
    const payloads = result.entries.map((e) => e.payload);
    expect(payloads.flatMap((p) => ("message" in p ? [p.message.chapterId] : []))).toEqual([
      lampsChapter,
      lampsChapter,
      lampsChapter,
    ]);
    expect(payloads.flatMap((p) => (p._tag === "ChannelUpserted" ? [p.channel.liveChapterId] : []))).toEqual(
      result.channels.map((t) => t.liveChapterId),
    );
    expect(payloads[0]?._tag === "ChannelUpserted" && payloads[0].channel.sessions[0]?.chapterId).toBe(lampsChapter);
  });
});

describe("chapters in the database", () => {
  const layer = Layer.mergeAll(HobbotsRepositoryLive, ChapterRepositoryLive, EventJournal.layer).pipe(
    Layer.provideMerge(TestDatabase),
  );

  // covers ADR 037 (Chapters), DP-003
  it("keeps one live chapter per channel and refuses a message without a chapter (#1379)", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* repo.insertAgent(hob("ada"));
      const channel = yield* repo.upsertChannel(newChannel("lamps"));
      const sql = yield* SqlClient.SqlClient;
      const secondLive = yield* Effect.exit(
        sql`INSERT INTO chapters ${sql.insert({
          id: "c2",
          channelId: "lamps",
          number: 2,
          state: "live",
          startedAt: NOW,
        })}`,
      );
      const resting = yield* Effect.exit(
        sql`INSERT INTO chapters ${sql.insert({
          id: "c3",
          channelId: "lamps",
          number: 2,
          state: "resting",
          startedAt: NOW,
        })}`,
      );
      const unknownState = yield* Effect.exit(
        sql`INSERT INTO chapters ${sql.insert({ id: "c4", channelId: "lamps", number: 3, state: "gone", startedAt: NOW })}`,
      );
      const orphan = yield* Effect.exit(
        sql`INSERT INTO messages ${sql.insert({
          id: "raw",
          channelId: "lamps",
          seq: 1,
          role: "user",
          content: "raw",
          status: "complete",
          createdAt: NOW,
        })}`,
      );
      const saved = yield* repo.upsertMessage(userMessage("lamps", "m1"));
      const cleared = yield* Effect.exit(sql`UPDATE messages SET chapter_id = NULL WHERE id = 'm1'`);
      // A channel saved again keeps its one chapter.
      yield* repo.upsertChannel(new Channel({ ...channel.value, title: "Renamed" }));
      const chapters = yield* (yield* ChapterRepository).listChapters(ChannelId.make("lamps"));
      return { channel: channel.value, secondLive, resting, unknownState, orphan, saved: saved.value, cleared, chapters };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Exit.isFailure(result.secondLive)).toBe(true);
    expect(Exit.isSuccess(result.resting)).toBe(true);
    expect(Exit.isFailure(result.unknownState)).toBe(true);
    expect(Exit.isFailure(result.orphan)).toBe(true);
    expect(Exit.isFailure(result.cleared)).toBe(true);
    expect(result.saved.chapterId).toBe(result.channel.liveChapterId);
    expect(result.chapters.map((c) => [c.id, c.state])).toEqual([
      [result.channel.liveChapterId, "live"],
      ["c3", "resting"],
    ]);
  });

  // covers ADR 037 (Chapters), STD-ARCH-014
  it("changes nothing when a command is sent again, or fails midway (#1379)", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const chapters = yield* ChapterRepository;
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* EventJournal;
      yield* repo.insertAgent(hob("ada"));
      yield* repo.insertAgent(hob("bo"));
      yield* repo.upsertChannel(newChannel("other", "bo"));
      const channel = ChannelId.make("lamps");
      yield* repo.upsertChannel(newChannel("lamps"));
      yield* repo.upsertMessage(userMessage("lamps", "m1"));
      const start = { id: ChapterId.make("c2"), title: "Garden", at: at(5) };
      const started = yield* chapters.startChapter(channel, start);
      const again = yield* chapters.startChapter(channel, start);
      yield* repo.upsertMessage(userMessage("lamps", "m2"));
      yield* repo.upsertMessage(userMessage("lamps", "m3"));
      const split = { id: ChapterId.make("c3"), messageId: MessageId.make("m3"), title: "Lamps" };
      yield* chapters.splitChapter(channel, split);
      const splitAgain = yield* chapters.splitChapter(channel, split);
      // Another channel already remembers a merged chapter by this id, so the merge fails at its last write.
      yield* sql`INSERT INTO merged_chapters ${sql.insert({
        id: "c3",
        channelId: "other",
        intoId: "x",
        mergedAt: NOW,
      })}`;
      const before = yield* journal.head;
      const failed = yield* Effect.exit(chapters.mergeChapters(channel, ChapterId.make("c3")));
      const afterFailure = {
        head: (yield* journal.head).sequence,
        chapters: (yield* chapters.listChapters(channel)).map((c) => [c.id, c.number, c.state]),
        messages: (yield* repo.listMessages(channel)).map((m) => [m.id, m.chapterId]),
      };
      yield* sql`DELETE FROM merged_chapters WHERE id = 'c3'`;
      const merged = yield* chapters.mergeChapters(channel, ChapterId.make("c3"));
      const mergedAgain = yield* chapters.mergeChapters(channel, ChapterId.make("c3"));
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

  // The model-based test: random messages, starts, splits and merges on a channel, against a model
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

  /** Runs an op on the channel: a message of yours, or a chapter command. */
  const perform = (op: Op, channelId: ChannelId, made: string, message: string, step: number) =>
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const store = yield* ChapterRepository;
      const id = ChapterId.make(made);
      switch (op._tag) {
        case "Say":
          return (yield* repo.upsertMessage(userMessage(channelId, message))).entries;
        case "Start":
          return (yield* store.startChapter(channelId, { id, title: op.title, at: at(step) })).entries;
        case "Split": {
          const point = (yield* repo.listMessages(channelId))[op.at]?.id ?? MessageId.make("missing");
          return (yield* store.splitChapter(channelId, { id, messageId: point, title: "Split" })).entries;
        }
        case "Merge": {
          const chapter = (yield* store.listChapters(channelId))[op.at];
          return (yield* store.mergeChapters(channelId, chapter?.id ?? ChapterId.make("missing"))).entries;
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
  it("keeps every message in exactly one chapter through random starts, splits and merges (#1379)", async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(ops, { minLength: 1, maxLength: 25 }), (script) =>
        hub.runPromise(
          Effect.gen(function* () {
            runs += 1;
            const repo = yield* HobbotsRepository;
            const store = yield* ChapterRepository;
            const channelId = ChannelId.make(`t${runs}`);
            const channel = (yield* repo.upsertChannel(newChannel(channelId))).value;
            let model: ReadonlyArray<ModelChapter> = [{ id: channel.liveChapterId as string, messages: [] }];
            for (const [step, op] of script.entries()) {
              const made = `t${runs}-c${step}`;
              const message = `t${runs}-m${step}`;
              const expected = modelStep(model, op, made, message);
              const outcome = yield* Effect.exit(perform(op, channelId, made, message, step));
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
              const chapters = yield* store.listChapters(channelId);
              const messages = yield* repo.listMessages(channelId);
              expect(
                chapters.map((c) => [c.id, c.number, c.state]),
                where,
              ).toEqual(model.map((c, index) => [c.id, index + 1, index === model.length - 1 ? "live" : "resting"]));
              expect(
                messages.map((m) => [m.id, m.chapterId]),
                where,
              ).toEqual(model.flatMap((c) => c.messages.map((m) => [m, c.id])));
              const stored = Option.getOrThrow(yield* repo.findChannel(channelId));
              expect(stored.liveChapterId, where).toBe(model.at(-1)?.id);
            }
          }),
        ),
      ),
      { numRuns: 40 },
    );
  });

  // covers ADR 037 (Chapters)
  it("refuses a move a chapter's state does not allow, and journals nothing (#1379)", async () => {
    const result = await hub.runPromise(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const store = yield* ChapterRepository;
        const sql = yield* SqlClient.SqlClient;
        const channelId = ChannelId.make("moved");
        yield* repo.upsertChannel(newChannel(channelId));
        yield* repo.upsertMessage(userMessage(channelId, "moved-m1"));
        yield* store.startChapter(channelId, { id: ChapterId.make("moved-c2"), title: "Next", at: at(1) });
        // A chapter that moved into a camp (#1364) takes nothing in.
        yield* repo.upsertChannel(newChannel("camp"));
        yield* sql`UPDATE chapters SET state = 'moved', moved_to = 'camp' WHERE channel_id = 'moved' AND number = 1`;
        const head = (yield* (yield* EventJournal).head).sequence;
        const refused = yield* Effect.exit(store.mergeChapters(channelId, ChapterId.make("moved-c2")));
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
  it("versions the messages a split or merge moves, and forgets what the old boundaries gave (#1379)", async () => {
    const result = await hub.runPromise(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const store = yield* ChapterRepository;
        const channelId = ChannelId.make("versions");
        yield* repo.upsertChannel(newChannel(channelId));
        const reply = (id: string) =>
          new Message({ ...userMessage(channelId, id), role: "assistant", content: `Reply ${id}` });
        for (const message of [userMessage(channelId, "v1"), reply("v2"), userMessage(channelId, "v3"), reply("v4")])
          yield* repo.upsertMessage(message);
        const stored = Option.getOrThrow(yield* repo.findChannel(channelId));
        const first = stored.liveChapterId as ChapterId;
        yield* repo.upsertChannel(
          new Channel({
            ...stored,
            sessions: [
              {
                runtime: "claude-code",
                agentId: AgentId.make("ada"),
                sessionId: "s1",
                chapterId: first,
                seenThrough: MessageId.make("v4"),
              },
            ],
          }),
        );
        yield* repo.markChannelRead(channelId, MessageId.make("v4"), Number.MAX_SAFE_INTEGER);
        const checkpoint = new ChannelCheckpoint({
          channelId,
          throughMessageId: MessageId.make("v4"),
          lines: ["- User: “v1”"],
          omitted: 0,
          createdAt: NOW,
        });
        yield* repo.saveCheckpoint(checkpoint);
        const revisions = () =>
          repo.listMessages(channelId).pipe(Effect.map((all) => all.map((m) => [m.id, m.chapterId, m.revision])));
        const before = yield* revisions();

        const split = yield* store.splitChapter(channelId, {
          id: ChapterId.make("versions-c2"),
          messageId: MessageId.make("v3"),
          title: "Later",
        });
        const unread = () => repo.listUnreadChannels.pipe(Effect.map((listed) => listed.channelIds.includes(channelId)));
        const afterSplit = {
          messages: yield* revisions(),
          unread: yield* unread(),
          channel: Option.getOrThrow(yield* repo.findChannel(channelId)),
          checkpoint: yield* repo.findCheckpoint(channelId),
        };
        yield* repo.saveCheckpoint(checkpoint);
        const merged = yield* store.mergeChapters(channelId, ChapterId.make("versions-c2"));
        const afterMerge = {
          messages: yield* revisions(),
          unread: yield* unread(),
          channel: Option.getOrThrow(yield* repo.findChannel(channelId)),
          checkpoint: yield* repo.findCheckpoint(channelId),
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
    // A channel you had read stays read, and the briefing summary of the old boundaries is gone.
    expect([result.afterSplit.unread, result.afterMerge.unread]).toEqual([false, false]);
    expect([Option.isNone(result.afterSplit.checkpoint), Option.isNone(result.afterMerge.checkpoint)]).toEqual([
      true,
      true,
    ]);
    // A split leaves the first chapter's session, which is resting; the merge makes it live again
    // and drops it, so it is never resumed.
    expect(result.afterSplit.channel.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(result.afterMerge.channel).toMatchObject({ liveChapterId: result.first, liveChapterMerges: 1, sessions: [] });
  });

  // covers ADR 037 (Chapters), STD-ARCH-014
  it("a channel read before a merge and written back with its session after it does not bring that session back (#1379)", async () => {
    const result = await hub.runPromise(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const store = yield* ChapterRepository;
        const channelId = ChannelId.make("fenced");
        yield* repo.upsertChannel(newChannel(channelId));
        yield* repo.upsertMessage(userMessage(channelId, "f1"));
        yield* repo.upsertMessage(userMessage(channelId, "f2"));
        yield* store.splitChapter(channelId, {
          id: ChapterId.make("fenced-c2"),
          messageId: MessageId.make("f2"),
          title: "Later",
        });
        yield* store.mergeChapters(channelId, ChapterId.make("fenced-c2"));
        // A turn records its session from a read of the channel, after which the chapter it read
        // as live is split off and merged back again, before the turn's write lands.
        const read = Option.getOrThrow(yield* repo.findChannel(channelId));
        const live = read.liveChapterId as ChapterId;
        const session = {
          runtime: "claude-code" as const,
          agentId: AgentId.make("ada"),
          sessionId: "s-before",
          chapterId: live,
          chapterMerges: read.liveChapterMerges,
          seenThrough: MessageId.make("f2"),
        };
        yield* repo.upsertMessage(userMessage(channelId, "f3"));
        yield* store.splitChapter(channelId, {
          id: ChapterId.make("fenced-c3"),
          messageId: MessageId.make("f3"),
          title: "Again",
        });
        yield* store.mergeChapters(channelId, ChapterId.make("fenced-c3"));
        yield* repo.upsertChannel(new Channel({ ...read, sessions: [session] }));
        const after = Option.getOrThrow(yield* repo.findChannel(channelId));
        // A session that started after the last merge is the one resumed.
        const fresh = new Channel({
          ...after,
          sessions: [{ ...session, sessionId: "s-after", chapterMerges: after.liveChapterMerges }],
        });
        return { read, after, fresh };
      }),
    );
    expect(result.read.liveChapterMerges).toBe(1);
    expect(result.after).toMatchObject({ liveChapterId: result.read.liveChapterId, liveChapterMerges: 2 });
    expect(result.after.sessions.map((s) => s.sessionId)).toEqual(["s-before"]);
    expect(liveSession(result.after, "claude-code", AgentId.make("ada"))).toBeUndefined();
    expect(liveSession(result.fresh, "claude-code", AgentId.make("ada"))?.sessionId).toBe("s-after");
  });
});
