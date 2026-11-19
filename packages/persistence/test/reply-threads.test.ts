import { ChapterRepository, HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  Channel,
  ChannelId,
  ChapterId,
  ChapterRefused,
  inMainLine,
  Message,
  MessageId,
  mainLine,
  OWNER_ACTOR,
  roleFields,
} from "@hobbots/domain";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { ChapterRepositoryLive, EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import { migrateAfter, TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1484 (ADR 039, Reply threads): a message names the root its reply thread hangs from. A reply
// is filed in its root's chapter, and a split keeps each thread with its root. No hob owes a reply in
// a thread an answer until threads have their own floor (#1485). Messages from before are in the main
// line. On SQLite and PostgreSQL alike.

const NOW = "2026-11-16T10:00:00.000Z";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const CHAT = ChannelId.make("chat");

const ada = new Agent({
  id: AgentId.make("ada"),
  name: "Ada",
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

const said = (id: string, root: string | null = null, alsoInMainLine = false) =>
  new Message({
    id: MessageId.make(id),
    channelId: CHAT,
    actor: OWNER_ACTOR,
    role: "user",
    content: id,
    status: "complete",
    error: null,
    configVersion: null,
    rootMessageId: root === null ? null : MessageId.make(root),
    alsoInMainLine,
    createdAt: NOW,
  });

const layer = Layer.mergeAll(HobbotsRepositoryLive, ChapterRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);

/** Ada's direct chat, where she is the only hob, so a main-line message of yours is hers to answer. */
const adaChat = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(ada);
  yield* repo.upsertChannel(
    new Channel({ id: CHAT, ownerHobId: ada.id, title: "Chat", createdAt: NOW, updatedAt: NOW }),
  );
  return repo;
});

const send = (message: Message) =>
  Effect.flatMap(HobbotsRepository, (repo) => repo.sendMessage(message, { mentions: [], repliesTo: null }));

describe("reply threads in the database", () => {
  // covers ADR 039 (Reply threads)
  it("stores a reply with its root, in its root's chapter, and owes no answer for it (#1484)", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* adaChat;
      const asked = yield* send(said("question"));
      // The chat moves on to a new chapter before anyone replies in the thread.
      yield* (yield* ChapterRepository).startChapter(CHAT, { id: ChapterId.make("later"), title: "Later", at: at(5) });
      const reply = yield* send(said("answer", "question", true));
      const owed = yield* repo.openTurnRequests(mainLine(CHAT));
      return { asked: asked.value, reply: reply.value, owed, stored: yield* repo.listMessages(CHAT) };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    // Your main-line message is Ada's to answer; your reply in its thread is nobody's yet.
    expect(result.asked.requests).toHaveLength(1);
    expect(result.reply.requests).toEqual([]);
    expect(result.owed.map((request) => request.messageId)).toEqual([MessageId.make("question")]);
    const [question, answer] = result.stored;
    expect(answer).toMatchObject({ rootMessageId: "question", alsoInMainLine: true, chapterId: question?.chapterId });
    expect(question).toMatchObject({ rootMessageId: null, alsoInMainLine: false });
    expect(result.stored.map(inMainLine)).toEqual([true, true]);
  });

  // covers ADR 039 (Reply threads: a reply thread is its root message's)
  it("refuses a reply whose root is a reply or not in the channel (#1484)", async () => {
    const result = await Effect.gen(function* () {
      yield* adaChat;
      yield* send(said("question"));
      yield* send(said("answer", "question"));
      const toReply = yield* Effect.exit(send(said("nested", "answer")));
      const toNothing = yield* Effect.exit(send(said("lost", "nowhere")));
      return { toReply, toNothing, stored: yield* (yield* HobbotsRepository).listMessages(CHAT) };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Exit.isFailure(result.toReply)).toBe(true);
    expect(Exit.isFailure(result.toNothing)).toBe(true);
    expect(result.stored.map((message) => message.id)).toEqual(["question", "answer"]);
  });

  // covers ADR 039 (Reply threads), ADR 037 (Chapters: split)
  it("keeps each thread with its root when a chapter is split, and never splits at a reply (#1484)", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* adaChat;
      const chapters = yield* ChapterRepository;
      yield* send(said("first"));
      yield* send(said("before"));
      yield* send(said("cut"));
      yield* send(said("after"));
      // Replies sent after the cut, to a root before it and to one after it.
      yield* send(said("old-reply", "before"));
      yield* send(said("new-reply", "after"));
      const atReply = yield* Effect.exit(
        chapters.splitChapter(CHAT, { id: ChapterId.make("no"), messageId: MessageId.make("old-reply"), title: "No" }),
      );
      yield* chapters.splitChapter(CHAT, { id: ChapterId.make("two"), messageId: MessageId.make("cut"), title: "Two" });
      const stored = yield* repo.listMessages(CHAT);
      return { atReply, chapterOf: Object.fromEntries(stored.map((message) => [message.id, message.chapterId])) };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Exit.isFailure(result.atReply) && Exit.findErrorOption(result.atReply)).toMatchObject({
      value: new ChapterRefused({ channelId: CHAT, reason: "message-not-found" }),
    });
    const first = result.chapterOf.first;
    expect(result.chapterOf).toEqual({
      first,
      before: first,
      "old-reply": first,
      cut: "two",
      after: "two",
      "new-reply": "two",
    });
  });
});

describe("20261116224606_reply_threads", () => {
  // covers ADR 039 (Reply threads), DP-003
  it("reads every message from before as a main-line message (#1484)", async () => {
    const earlier = Object.fromEntries(
      Object.entries(migrations).filter(([id]) => id < "20261116224606"),
    ) as typeof migrations;
    const stored = await Effect.gen(function* () {
      const repo = yield* adaChat;
      const sql = yield* SqlClient.SqlClient;
      const [live] = yield* sql<{ readonly id: string }>`SELECT id FROM chapters WHERE channel_id = ${CHAT}`;
      yield* sql`INSERT INTO messages ${sql.insert({
        id: "old",
        channelId: CHAT,
        chapterId: live?.id ?? null,
        role: "user",
        content: "From before threads",
        status: "complete",
        actorKind: "user",
        actorId: OWNER_ACTOR.id,
        createdAt: NOW,
        seq: 1,
      })}`;
      yield* migrateAfter("20261116004540");
      return yield* repo.listMessages(CHAT);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer).pipe(Layer.provideMerge(TestDatabaseAt(earlier))),
      ),
      Effect.runPromise,
    );
    expect(stored.map((message) => [message.id, message.rootMessageId, message.alsoInMainLine])).toEqual([
      ["old", null, false],
    ]);
  });
});
