import { CatchUpRepository, HobbotsRepository, PinRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  type ChapterId,
  DEFAULT_QUEST_LIMITS,
  Message,
  MessageId,
  OWNER_ACTOR,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  BackpackLive,
  CatchUpRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  PinRepositoryLive,
  TaskRepositoryLive,
} from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1387 (ADR 037, Mine and Catch-up): a pin marks a message without changing it, so pinning
// leaves the thread read; it follows its message into a camp and goes when the message does. What
// catch-up reads besides the transcript is the read marker and the Quests started in the thread.
// On SQLite and PostgreSQL alike.

const TestLayer = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  BackpackLive,
  PinRepositoryLive,
  CatchUpRepositoryLive,
).pipe(Layer.provideMerge(EventJournal.layer), Layer.provideMerge(TestDatabase));

type Services =
  | HobbotsRepository
  | TaskRepository
  | PinRepository
  | CatchUpRepository
  | EventJournal
  | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer), Effect.scoped) as Effect.Effect<A, E>);

const NOW = "2026-11-12T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const CHAT = ThreadId.make("chat-1");
const CAMP = ThreadId.make("camp-1");

const message = (id: string, role: Message["role"], status: Message["status"] = "complete") =>
  new Message({
    id: MessageId.make(id),
    threadId: CHAT,
    actor: role === "assistant" ? null : OWNER_ACTOR,
    role,
    content: id,
    status,
    error: null,
    configVersion: role === "assistant" ? (1 as Message["configVersion"]) : null,
    createdAt: NOW,
  });

/** Aldric's chat with a question, a reply and a message still queued. */
const chat = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: ALDRIC,
      name: "Aldric",
      roleTitle: "Guide",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: NOW,
    }),
  );
  yield* repo.upsertThread(
    new Thread({ id: CHAT, agentId: ALDRIC, title: "Chat", kind: "chat", createdAt: NOW, updatedAt: NOW }),
  );
  yield* repo.upsertMessage(message("ask", "user"));
  const reply = yield* repo.upsertMessage(message("reply", "assistant"));
  yield* repo.upsertMessage(message("later", "user", "queued"));
  return reply.value;
});

const pin = (messageId: string, pinned = true, threadId: ThreadId = CHAT) =>
  Effect.gen(function* () {
    const pins = yield* PinRepository;
    return yield* pins.setPinned(threadId, MessageId.make(messageId), pinned, NOW);
  });

describe("pins", () => {
  // covers CH-001, ADR 037 (Mine: pins)
  it("[TC-CH-1387-05] pins a message once without making the thread unread, and journals each change", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const reply = yield* chat;
        yield* repo.markThreadRead(CHAT, reply.id, reply.revision);
        const first = yield* pin("reply");
        const again = yield* pin("reply");
        const unread = (yield* repo.listUnreadThreads).threadIds.includes(CHAT);
        const listed = yield* (yield* PinRepository).listPins(CHAT);
        const off = yield* pin("reply", false);
        const offAgain = yield* pin("reply", false);
        const elsewhere = yield* Effect.exit(pin("reply", true, ThreadId.make("other")));
        return { first, again, unread, listed, off, offAgain, elsewhere };
      }),
    );
    expect(result.first.value).toMatchObject({ messageId: "reply", threadId: CHAT, pinnedAt: NOW });
    expect(result.first.entries.map((entry) => entry.type)).toEqual(["MessagePinned"]);
    expect(result.again).toMatchObject({ value: result.first.value, entries: [] });
    expect(result.unread).toBe(false);
    expect(result.listed).toEqual([result.first.value]);
    expect(result.off.entries.map((entry) => entry.payload)).toEqual([
      { _tag: "MessageUnpinned", threadId: CHAT, messageId: "reply" },
    ]);
    expect(result.offAgain).toMatchObject({ value: null, entries: [] });
    expect(Exit.isFailure(result.elsewhere)).toBe(true);
  });

  // covers CH-001, CH-008, ADR 037 (Mine: pins)
  it("[TC-CH-1387-06] lists a pin under its message's camp once the chapter moves, and drops it with the message", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const pins = yield* PinRepository;
        const reply = yield* chat;
        yield* pin("reply");
        yield* pin("later");
        yield* repo.removeQueuedMessage(CHAT, MessageId.make("later"));
        yield* repo.moveChapter({
          threadId: CHAT,
          chapterId: reply.chapterId as ChapterId,
          target: {
            _tag: "new",
            camp: new Thread({
              id: CAMP,
              agentId: ALDRIC,
              title: "Launch",
              kind: "camp",
              origin: { threadId: CHAT, chapterId: null },
              createdAt: NOW,
              updatedAt: NOW,
            }),
          },
          at: NOW,
        });
        return { chat: yield* pins.listPins(CHAT), camp: yield* pins.listPins(CAMP) };
      }),
    );
    expect(result.chat).toEqual([]);
    expect(result.camp.map((each) => [each.messageId, each.threadId])).toEqual([["reply", CAMP]]);
  });
});

describe("what catch-up reads", () => {
  // covers CH-001, ADR 037 (Catch-up)
  it("[TC-CH-1387-07] reads no marker in a thread never read, the marker once read, and the Quests started there", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const tasks = yield* TaskRepository;
        const reads = yield* CatchUpRepository;
        const reply = yield* chat;
        const never = yield* reads.marker(CHAT);
        const none = yield* reads.quests(CHAT);
        yield* repo.markThreadRead(CHAT, reply.id, reply.revision);
        const task = {
          id: TaskId.make("launch"),
          ownerId: ALDRIC,
          parentId: null,
          threadId: CHAT,
          brief: "Launch",
          dependsOn: [],
          createdAt: NOW,
        };
        yield* tasks.createTask({ task, delegation: null, milestones: [] });
        yield* tasks.startQuest({
          id: QuestId.make("launch-quest"),
          taskId: task.id,
          goal: "Ship the launch",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: NOW,
        });
        return { never, none, marker: yield* reads.marker(CHAT), quests: yield* reads.quests(CHAT), reply };
      }),
    );
    expect(result.never).toBeNull();
    expect(result.none).toEqual([]);
    expect(result.marker).toBe(result.reply.revision);
    expect(result.quests).toMatchObject([
      { summary: { questId: "launch-quest", parentQuestId: null, state: "active" }, goal: "Ship the launch" },
    ]);
  });
});

// The note's actor is yours, wherever it is read back.
it("[TC-CH-1387-08] keeps a note's author as you", async () => {
  const note = await run(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      yield* chat;
      yield* repo.upsertMessage(new Message({ ...message("note", "note"), actor: OWNER_ACTOR }));
      return Option.getOrThrow(yield* repo.findMessage(MessageId.make("note")));
    }),
  );
  expect(note).toMatchObject({ role: "note", actor: OWNER_ACTOR });
});
