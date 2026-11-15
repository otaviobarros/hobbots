import { HobbotsRepository, type NewTask, TaskRepository } from "@hobbots/agents";
import { ChannelKeyReused } from "@hobbots/api";
import {
  Agent,
  AgentId,
  DEFAULT_QUEST_LIMITS,
  QuestId,
  QuestionId,
  TaskId,
  Channel,
  ChannelId,
  ChannelLifecycle,
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
const CHAT = ChannelId.make("chat-1");
const FRESH = ChannelId.make("chat-2");

let clock = 0;
const newTask = (id: string, parentId: string | null): NewTask => ({
  id: TaskId.make(id),
  ownerId: ALDRIC,
  parentId: parentId === null ? null : TaskId.make(parentId),
  channelId: CHAT,
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
  const chat = yield* repo.upsertChannel(
    new Channel({ id: CHAT, ownerHobId: ALDRIC, title: "Lamps", kind: "direct", createdAt: NOW, updatedAt: NOW }),
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

const supersede = (chat: Channel) => {
  const next = ChannelLifecycle.transition(chat, {
    _tag: "Supersede",
    at: LATER,
    hobRetired: false,
    approvalPending: false,
    replyRunning: false,
  });
  if (!(next instanceof Channel)) throw next;
  return next;
};

const freshChat = new Channel({
  id: FRESH,
  ownerHobId: ALDRIC,
  title: "New channel",
  kind: "direct",
  origin: { channelId: CHAT, chapterId: null },
  createdAt: LATER,
  updatedAt: LATER,
});

const camp = (fields: Partial<Channel> = {}) =>
  new Channel({
    id: ChannelId.make("camp-1"),
    ownerHobId: ALDRIC,
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
    sql<{ id: string; channelId: string | null }>`SELECT id, channel_id FROM ${sql(table)} ORDER BY id`;
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
    type: "ChannelUpserted",
    schema_version: 4,
    occurred_at: NOW,
    payload: "{}",
  })}`;
  return sql`DELETE FROM event_journal WHERE id = 'planted'`;
});

describe("Make a camp", () => {
  it("writes the camp and journals CampMade once, answers the same request again even after a rename, and refuses a reused key (#1376)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* hobWithChat;
        const repo = yield* HobbotsRepository;
        const journal = yield* EventJournal;
        const made = yield* repo.makeCamp(camp());
        const again = yield* repo.makeCamp(camp({ createdAt: LATER, updatedAt: LATER }));
        // Renamed since, the camp still answers the request that made it.
        const renamed = yield* repo.upsertChannel(new Channel({ ...made.value, title: "Launch post, renamed" }));
        const afterRename = yield* repo.makeCamp(camp({ createdAt: LATER, updatedAt: LATER }));
        const reused = yield* Effect.exit(repo.makeCamp(camp({ title: "Something else" })));
        const onChat = yield* Effect.exit(repo.makeCamp(camp({ id: CHAT })));
        return { made, again, renamed, afterRename, reused, onChat, entries: yield* journal.readAfter(0) };
      }),
    );

    expect(result.made.value).toMatchObject({
      kind: "camp",
      goal: "Write the launch post",
      private: true,
      state: "open",
      origin: null,
    });
    // The camp starts its first chapter in the same change (ADR 037, #1379), with its person and its
    // hob as its first members (ADR 039).
    expect(result.made.entries.map((entry) => entry.payload._tag)).toEqual([
      "CampMade",
      "ChapterStarted",
      "ChannelMemberAdded",
      "ChannelMemberAdded",
    ]);
    expect(result.made.entries.slice(2).map((entry) => entry.payload)).toMatchObject([
      { member: { actor: { kind: "user", id: "owner" }, role: "owner", state: "active" } },
      { member: { actor: { kind: "hob" }, role: "member", state: "active" } },
    ]);
    expect(result.made.value.liveChapterId).not.toBeNull();
    expect(result.again.entries).toEqual([]);
    expect(result.again.value).toEqual(result.made.value);
    expect(result.afterRename.entries).toEqual([]);
    expect(result.afterRename.value).toEqual(result.renamed.value);
    expect(result.reused).toEqual(Exit.fail(new ChannelKeyReused({ channelId: ChannelId.make("camp-1") })));
    expect(result.onChat).toEqual(Exit.fail(new ChannelKeyReused({ channelId: CHAT })));
    expect(result.entries.filter((entry) => entry.payload._tag === "CampMade")).toHaveLength(1);
  });
});

describe("Start fresh", () => {
  it("moves every open thing to the new chat once, records it as carried over, and leaves none on the old chat (#1376)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* hobWithChat;
        yield* openWork;
        const repo = yield* HobbotsRepository;
        const stored = Option.getOrThrow(yield* repo.findChannel(CHAT));
        const started = Option.getOrThrow(yield* repo.startFresh({ superseded: supersede(stored), chat: freshChat }));
        return {
          chat,
          started,
          places: yield* placesOf,
          carried: yield* repo.listCarriedOver(FRESH),
          live: yield* repo.listChannels(ALDRIC),
          archived: yield* repo.listArchivedChannels(ALDRIC),
        };
      }),
    );

    const { started } = result;
    expect(started.value.superseded).toMatchObject({ id: CHAT, state: "superseded", archivedAt: LATER });
    expect(started.value.chat).toMatchObject({ id: FRESH, kind: "direct", state: "open", origin: { channelId: CHAT } });
    expect(started.value.carried.map((item) => [item.ref._tag, item.label])).toEqual([
      ["task", "Brief for launch"],
      ["question", "Which lamps first?"],
      ["backpack-item", "failure about Brief for wire"],
    ]);
    expect(result.carried).toEqual(started.value.carried);
    // One event for the chat, then each moved item, at the revision it was written with: the
    // failure the chat carries, and the step's own Task item, which moves with its tree unnamed.
    // Then the new chat's first chapter (ADR 037, #1379), the old chat's members in the new one
    // (ADR 039), and last the moved Quest's summary, which now names the new chat (#1373).
    const tags = started.entries.map((entry) => entry.payload._tag);
    expect(tags).toEqual([
      "ChatStartedFresh",
      "BackpackItemChanged",
      "BackpackItemChanged",
      "ChapterStarted",
      "ChannelMemberAdded",
      "ChannelMemberAdded",
      "QuestSummaryChanged",
    ]);
    expect(started.entries.slice(4, 6).map((entry) => entry.payload)).toMatchObject([
      { member: { channelId: FRESH, actor: { kind: "user", id: "owner" }, role: "owner" } },
      { member: { channelId: FRESH, actor: { kind: "hob" }, role: "member" } },
    ]);
    expect(started.entries[6]?.payload).toMatchObject({ summary: { channelId: FRESH } });
    expect(started.value.chat.liveChapterId).not.toBeNull();
    const [fresh, ...rest] = started.entries;
    const moved = rest.filter((entry) => entry.payload._tag === "BackpackItemChanged");
    expect(fresh?.correlation.channelId).toBe(FRESH);
    for (const entry of moved) {
      expect(entry.payload).toMatchObject({ item: { channelId: FRESH, revision: entry.sequence } });
    }
    // The open tree and its Quest moved; the Task that was over stays where it was.
    expect(result.places.tasks).toEqual([
      { id: "launch", channelId: FRESH },
      { id: "old", channelId: CHAT },
      { id: "wire", channelId: FRESH },
    ]);
    expect(result.places.quests).toEqual([{ id: "quest-1", channelId: FRESH }]);
    expect(result.places.items.every((item) => item.channelId === FRESH)).toBe(true);
    expect(result.places.carried).toHaveLength(3);
    // The hob keeps one open chat: the new one is listed, the old one is with the archived channels.
    expect(result.live.map((channel) => channel.id)).toEqual([FRESH]);
    expect(result.archived.map((channel) => [channel.id, channel.state])).toEqual([[CHAT, "superseded"]]);
  });

  it("writes nothing when the chat changed since it was read (#1376)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* hobWithChat;
        const repo = yield* HobbotsRepository;
        // A turn recorded its session after the chat was read.
        yield* repo.upsertChannel(new Channel({ ...chat, title: "Lamps, renamed" }));
        const stale = yield* repo.startFresh({ superseded: supersede(chat), chat: freshChat });
        return { stale, channel: yield* repo.findChannel(FRESH), chat: yield* repo.findChannel(CHAT) };
      }),
    );
    expect(Option.isNone(result.stale)).toBe(true);
    expect(Option.isNone(result.channel)).toBe(true);
    expect(Option.getOrThrow(result.chat).state).toBe("open");
  });

  it("leaves neither half of Make a camp or Start fresh when it fails midway through its writes (#1376)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* hobWithChat;
        yield* openWork;
        const repo = yield* HobbotsRepository;
        const before = yield* placesOf;
        const clear = yield* breakNextAppend;
        const campExit = yield* Effect.exit(repo.makeCamp(camp()));
        const stored = Option.getOrThrow(yield* repo.findChannel(CHAT));
        const freshExit = yield* Effect.exit(repo.startFresh({ superseded: supersede(stored), chat: freshChat }));
        yield* clear;
        return {
          campExit,
          freshExit,
          before,
          after: yield* placesOf,
          camp: yield* repo.findChannel(ChannelId.make("camp-1")),
          fresh: yield* repo.findChannel(FRESH),
          chat: yield* repo.findChannel(CHAT),
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
