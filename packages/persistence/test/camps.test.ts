import { HobbotsRepository, type NewTask, TaskRepository } from "@hobbots/agents";
import { ThreadKeyReused } from "@hobbots/api";
import {
  Agent,
  AgentId,
  DEFAULT_QUEST_LIMITS,
  QuestId,
  QuestionId,
  TaskId,
  Thread,
  ThreadId,
  ThreadLifecycle,
} from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { BackpackLive, EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1376 (ADR 037): Make a camp and Start fresh each write in one transaction. Start fresh moves
// what the chat still owes you into the new chat, records each thing once as carried over, and leaves
// none of it on the old chat. A crash between the writes leaves neither half, on SQLite and PostgreSQL.

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, BackpackLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | EventJournal | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const NOW = "2026-11-11T00:00:00.000Z";
const LATER = "2026-11-11T01:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const CHAT = ThreadId.make("chat-1");
const FRESH = ThreadId.make("chat-2");

let clock = 0;
const newTask = (id: string, parentId: string | null): NewTask => ({
  id: TaskId.make(id),
  ownerId: ALDRIC,
  parentId: parentId === null ? null : TaskId.make(parentId),
  threadId: CHAT,
  brief: `Brief for ${id}`,
  dependsOn: [],
  createdAt: new Date(Date.parse(NOW) + 1000 * ++clock).toISOString(),
});

/** Aldric and his chat. */
const hobWithChat = Effect.gen(function* () {
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
  const chat = yield* repo.upsertThread(
    new Thread({ id: CHAT, agentId: ALDRIC, title: "Lamps", kind: "chat", createdAt: NOW, updatedAt: NOW }),
  );
  return chat.value;
});

/**
 * What the chat still owes: a Quest on a Task you asked for, with a question waiting for you and a
 * failed step whose failure waits for Aldric, and a Task already done, which stays.
 */
const openWork = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  yield* tasks.createTask({ task: newTask("launch", null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("quest-1"),
    taskId: TaskId.make("launch"),
    goal: "Launch the lamps",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: NOW,
  });
  yield* tasks.askQuestion({
    id: QuestionId.make("which"),
    taskId: TaskId.make("launch"),
    askerId: ALDRIC,
    text: "Which lamps first?",
    createdAt: NOW,
  });
  const step = yield* tasks.createTask({ task: newTask("wire", "launch"), delegation: null, milestones: [] });
  yield* tasks.moveTask(step.value.id, step.value.revision, "failed", NOW);
  const done = yield* tasks.createTask({ task: newTask("old", null), delegation: null, milestones: [] });
  yield* tasks.moveTask(done.value.id, done.value.revision, "cancelled", NOW);
});

const supersede = (chat: Thread) => {
  const next = ThreadLifecycle.transition(chat, {
    _tag: "Supersede",
    at: LATER,
    hobRetired: false,
    approvalPending: false,
    replyRunning: false,
  });
  if (!(next instanceof Thread)) throw next;
  return next;
};

const freshChat = new Thread({
  id: FRESH,
  agentId: ALDRIC,
  title: "New thread",
  kind: "chat",
  origin: { threadId: CHAT, chapterId: null },
  createdAt: LATER,
  updatedAt: LATER,
});

const camp = (fields: Partial<Thread> = {}) =>
  new Thread({
    id: ThreadId.make("camp-1"),
    agentId: ALDRIC,
    title: "Launch post",
    kind: "camp",
    goal: "Write the launch post",
    private: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  });

/** Where the chat's work is now, by table. */
const placesOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = (table: string) =>
    sql<{ id: string; threadId: string | null }>`SELECT id, thread_id FROM ${sql(table)} ORDER BY id`;
  return {
    tasks: yield* rows("tasks"),
    quests: yield* rows("quests"),
    items: yield* rows("backpack_items"),
    carried: yield* sql`SELECT * FROM carried_over`,
  };
});

/** Takes the journal sequence the next change will use, as a crash midway through its writes would. */
const breakNextAppend = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const journal = yield* EventJournal;
  const next = (yield* journal.head).sequence + 1;
  yield* sql`INSERT INTO event_journal ${sql.insert({
    sequence: next,
    id: "planted",
    type: "ThreadUpserted",
    schema_version: 4,
    occurred_at: NOW,
    payload: "{}",
  })}`;
  return sql`DELETE FROM event_journal WHERE id = 'planted'`;
});

describe("Make a camp", () => {
  // covers CH-009
  it("[TC-CH-1376-01] writes the camp and journals CampMade once, answers the same request again, and refuses a reused key", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* hobWithChat;
        const repo = yield* HobbotsRepository;
        const journal = yield* EventJournal;
        const made = yield* repo.makeCamp(camp());
        const again = yield* repo.makeCamp(camp({ createdAt: LATER, updatedAt: LATER }));
        const reused = yield* Effect.exit(repo.makeCamp(camp({ title: "Something else" })));
        const onChat = yield* Effect.exit(repo.makeCamp(camp({ id: CHAT })));
        return { made, again, reused, onChat, entries: yield* journal.readAfter(0) };
      }),
    );

    expect(result.made.value).toMatchObject({
      kind: "camp",
      goal: "Write the launch post",
      private: true,
      state: "open",
      origin: null,
    });
    expect(result.made.entries.map((entry) => entry.payload._tag)).toEqual(["CampMade"]);
    expect(result.again.entries).toEqual([]);
    expect(result.again.value).toEqual(result.made.value);
    expect(result.reused).toEqual(Exit.fail(new ThreadKeyReused({ threadId: ThreadId.make("camp-1") })));
    expect(result.onChat).toEqual(Exit.fail(new ThreadKeyReused({ threadId: CHAT })));
    expect(result.entries.filter((entry) => entry.payload._tag === "CampMade")).toHaveLength(1);
  });
});

describe("Start fresh", () => {
  // covers CH-009, IN-001
  it("[TC-CH-1376-02] moves every open thing to the new chat once, records it as carried over, and leaves none on the old chat", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* hobWithChat;
        yield* openWork;
        const repo = yield* HobbotsRepository;
        const stored = Option.getOrThrow(yield* repo.findThread(CHAT));
        const started = Option.getOrThrow(yield* repo.startFresh({ superseded: supersede(stored), chat: freshChat }));
        return {
          chat,
          started,
          places: yield* placesOf,
          carried: yield* repo.listCarriedOver(FRESH),
          live: yield* repo.listThreads(ALDRIC),
          archived: yield* repo.listArchivedThreads(ALDRIC),
        };
      }),
    );

    const { started } = result;
    expect(started.value.superseded).toMatchObject({ id: CHAT, state: "superseded", archivedAt: LATER });
    expect(started.value.chat).toMatchObject({ id: FRESH, kind: "chat", state: "open", origin: { threadId: CHAT } });
    expect(started.value.carried.map((item) => [item.ref._tag, item.label])).toEqual([
      ["task", "Brief for launch"],
      ["question", "Which lamps first?"],
      ["backpack-item", "failure about Brief for wire"],
    ]);
    expect(result.carried).toEqual(started.value.carried);
    // One event for the chat, then each moved item, at the revision it was written with: the
    // failure the chat carries, and the step's own Task item, which moves with its tree unnamed.
    const tags = started.entries.map((entry) => entry.payload._tag);
    expect(tags).toEqual(["ChatStartedFresh", "BackpackItemChanged", "BackpackItemChanged"]);
    const [fresh, ...moved] = started.entries;
    expect(fresh?.correlation.threadId).toBe(FRESH);
    for (const entry of moved) {
      expect(entry.payload).toMatchObject({ item: { threadId: FRESH, revision: entry.sequence } });
    }
    // The open tree and its Quest moved; the Task that was over stays where it was.
    expect(result.places.tasks).toEqual([
      { id: "launch", threadId: FRESH },
      { id: "old", threadId: CHAT },
      { id: "wire", threadId: FRESH },
    ]);
    expect(result.places.quests).toEqual([{ id: "quest-1", threadId: FRESH }]);
    expect(result.places.items.every((item) => item.threadId === FRESH)).toBe(true);
    expect(result.places.carried).toHaveLength(3);
    // The hob keeps one open chat: the new one is listed, the old one is with the archived threads.
    expect(result.live.map((thread) => thread.id)).toEqual([FRESH]);
    expect(result.archived.map((thread) => [thread.id, thread.state])).toEqual([[CHAT, "superseded"]]);
  });

  // covers CH-009
  it("[TC-CH-1376-03] writes nothing when the chat changed since it was read", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* hobWithChat;
        const repo = yield* HobbotsRepository;
        // A turn recorded its session after the chat was read.
        yield* repo.upsertThread(new Thread({ ...chat, title: "Lamps, renamed" }));
        const stale = yield* repo.startFresh({ superseded: supersede(chat), chat: freshChat });
        return { stale, thread: yield* repo.findThread(FRESH), chat: yield* repo.findThread(CHAT) };
      }),
    );
    expect(Option.isNone(result.stale)).toBe(true);
    expect(Option.isNone(result.thread)).toBe(true);
    expect(Option.getOrThrow(result.chat).state).toBe("open");
  });

  // covers CH-009, DP-001
  it("[TC-CH-1376-04] leaves neither half of Make a camp or Start fresh when it fails midway through its writes", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* hobWithChat;
        yield* openWork;
        const repo = yield* HobbotsRepository;
        const before = yield* placesOf;
        const clear = yield* breakNextAppend;
        const campExit = yield* Effect.exit(repo.makeCamp(camp()));
        const stored = Option.getOrThrow(yield* repo.findThread(CHAT));
        const freshExit = yield* Effect.exit(repo.startFresh({ superseded: supersede(stored), chat: freshChat }));
        yield* clear;
        return {
          campExit,
          freshExit,
          before,
          after: yield* placesOf,
          camp: yield* repo.findThread(ThreadId.make("camp-1")),
          fresh: yield* repo.findThread(FRESH),
          chat: yield* repo.findThread(CHAT),
          // Once the journal takes writes again, the same Start fresh goes through whole.
          retried: yield* repo.startFresh({ superseded: supersede(stored), chat: freshChat }),
        };
      }),
    );
    expect(Exit.isFailure(result.campExit)).toBe(true);
    expect(Exit.isFailure(result.freshExit)).toBe(true);
    expect(result.after).toEqual(result.before);
    expect(Option.isNone(result.camp)).toBe(true);
    expect(Option.isNone(result.fresh)).toBe(true);
    expect(Option.getOrThrow(result.chat)).toMatchObject({ state: "open", archivedAt: null });
    expect(Option.getOrThrow(result.retried).value.carried).toHaveLength(3);
  });
});
