import { HobAdmission, HobbotsRepository, ReplyThreads } from "@hobbots/agents";
import { ChannelArchived, MessageKeyReused, MessageNotFound, UserSession } from "@hobbots/api";
import {
  Agent,
  AgentId,
  Channel,
  ChannelId,
  inMainLine,
  Message,
  MessageId,
  mainLine,
  OWNER_ACTOR,
  roleFields,
} from "@hobbots/domain";
import { HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

// Issue #1484 (ADR 039, Reply threads): you reply in the thread of any main-line message. The reply
// names its root, a reply to a reply goes to the same thread, and Also send to the camp puts it in the
// main line too. A note to self or a queued message carries no thread. No hob is woken for a reply in
// a thread yet (#1485).

const NOW = "2026-11-16T10:00:00.000Z";
const CHAT = ChannelId.make("chat");

const YOU = UserSession.of({
  deviceId: "device-1" as UserSession["Service"]["deviceId"],
  name: "Your Mac",
  kind: "desktop" as UserSession["Service"]["kind"],
  userId: "owner" as UserSession["Service"]["userId"],
  actor: OWNER_ACTOR,
  whileApproved: (write) => write,
});

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

const message = (id: string, fields: Partial<Pick<Message, "role" | "status">> = {}) =>
  new Message({
    id: MessageId.make(id),
    channelId: CHAT,
    actor: OWNER_ACTOR,
    role: fields.role ?? "user",
    content: id,
    status: fields.status ?? "complete",
    error: null,
    configVersion: null,
    createdAt: NOW,
  });

const layer = ReplyThreads.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive.pipe(Layer.provideMerge(TestDatabase)), HobAdmission.layer)),
);

/** Ada's chat with your question, a note to self and a message still waiting its turn. */
const chat = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(ada);
  yield* repo.upsertChannel(
    new Channel({ id: CHAT, ownerHobId: ada.id, title: "Chat", createdAt: NOW, updatedAt: NOW }),
  );
  yield* repo.upsertMessage(message("question"));
  yield* repo.upsertMessage(message("note", { role: "note" }));
  yield* repo.upsertMessage(message("waiting", { status: "queued" }));
  return repo;
});

const reply = (root: string, key: string, alsoInMainLine = false, content = key) =>
  Effect.flatMap(ReplyThreads, (threads) =>
    threads.reply(CHAT, MessageId.make(root), { key: MessageId.make(key), content, alsoInMainLine }),
  ).pipe(Effect.provideService(UserSession, YOU));

describe("replying in a thread", () => {
  // covers ADR 039 (Reply threads, Also send to the camp)
  it("writes your replies in the root's thread, a reply to a reply in the same one, and wakes no hob (#1484)", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* chat;
      const first = yield* reply("question", "r1");
      const toReply = yield* reply("r1", "r2", true);
      const again = yield* reply("question", "r1");
      // Sent again from the thread's other message, it is still the same reply.
      const againFromReply = yield* reply("r2", "r1");
      return { first, toReply, again, againFromReply, owed: yield* repo.openTurnRequests(mainLine(CHAT)) };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.first).toMatchObject({ rootMessageId: "question", alsoInMainLine: false, actor: OWNER_ACTOR });
    expect(result.toReply).toMatchObject({ rootMessageId: "question", alsoInMainLine: true });
    expect([result.first, result.toReply].map(inMainLine)).toEqual([false, true]);
    // The same reply sent again is the one written.
    expect(result.again.revision).toBe(result.first.revision);
    expect(result.againFromReply.revision).toBe(result.first.revision);
    expect(result.owed).toEqual([]);
  });

  // covers ADR 039 (Reply threads), ADR 037 (Notes to self)
  it("finds no thread on a note, a queued message or a message elsewhere, and refuses a reused key (#1484)", async () => {
    const result = await Effect.gen(function* () {
      const repo = yield* chat;
      yield* reply("question", "r1");
      const exits = {
        note: yield* Effect.exit(reply("note", "r2")),
        queued: yield* Effect.exit(reply("waiting", "r3")),
        missing: yield* Effect.exit(reply("elsewhere", "r4")),
        reused: yield* Effect.exit(reply("question", "r1", false, "Something else")),
        // The same words sent again, now also to the main line, are not the reply that was written.
        alsoNow: yield* Effect.exit(reply("question", "r1", true)),
      };
      yield* repo.upsertChannel(
        new Channel({ id: CHAT, ownerHobId: ada.id, title: "Chat", createdAt: NOW, updatedAt: NOW, archivedAt: NOW }),
      );
      return { ...exits, archived: yield* Effect.exit(reply("question", "r5")) };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Exit.findErrorOption(exit) : null);
    expect(failure(result.note)).toMatchObject({
      value: new MessageNotFound({ channelId: CHAT, messageId: MessageId.make("note") }),
    });
    expect(failure(result.queued)).toMatchObject({
      value: new MessageNotFound({ channelId: CHAT, messageId: MessageId.make("waiting") }),
    });
    expect(failure(result.missing)).toMatchObject({
      value: new MessageNotFound({ channelId: CHAT, messageId: MessageId.make("elsewhere") }),
    });
    expect(failure(result.reused)).toMatchObject({ value: new MessageKeyReused({ messageId: MessageId.make("r1") }) });
    expect(failure(result.alsoNow)).toMatchObject({ value: new MessageKeyReused({ messageId: MessageId.make("r1") }) });
    expect(failure(result.archived)).toMatchObject({
      value: new ChannelArchived({ channelId: CHAT, archivedAt: NOW }),
    });
  });
});
