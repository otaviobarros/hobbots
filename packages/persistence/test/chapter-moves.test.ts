import {
  CampSuggestionRepository,
  type ChapterMoveTarget,
  ChapterRepository,
  HobbotsRepository,
  type NewTask,
  RecordRepository,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  AttemptId,
  CAMP_SUGGESTION_DECISIONS,
  CAMP_SUGGESTION_QUESTS,
  type CampSuggestion,
  ChapterId,
  ChapterStates,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DecisionId,
  Message,
  MessageId,
  OWNER_ACTOR,
  QuestId,
  QuestionId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  BackpackLive,
  CampSuggestionRepositoryLive,
  ChapterRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  RecordRepositoryLive,
  TaskRepositoryLive,
} from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1385 (ADR 037): moving a chapter into a camp re-parents its messages, decisions, artifacts
// and the quests started in it, with their open questions and backpack items, in one transaction,
// and leaves a stub in the chat, so nothing is ever in two places and a crash midway moves nothing.
// A chat chapter that grows past a threshold gets one camp suggestion, raised in the transaction
// that grew it; Keep in chat keeps it from coming back. On SQLite and PostgreSQL alike.

const TestLayer = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  BackpackLive,
  RecordRepositoryLive,
  ChapterRepositoryLive,
  CampSuggestionRepositoryLive,
).pipe(Layer.provideMerge(EventJournal.layer), Layer.provideMerge(TestDatabase));

type Services =
  | HobbotsRepository
  | TaskRepository
  | RecordRepository
  | ChapterRepository
  | CampSuggestionRepository
  | EventJournal
  | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer), Effect.scoped) as Effect.Effect<A, E>);

const NOW = "2026-11-12T00:00:00.000Z";
const LATER = "2026-11-12T01:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const CHAT = ThreadId.make("chat-1");
const CAMP = ThreadId.make("camp-1");

let clock = 0;
const tick = () => new Date(Date.parse(NOW) + 1000 * ++clock).toISOString();

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });

const thread = (id: ThreadId, fields: Partial<Thread> = {}) =>
  new Thread({ id, agentId: ALDRIC, title: id, kind: "camp", createdAt: NOW, updatedAt: NOW, ...fields });

const newCamp = (fields: Partial<Thread> = {}) =>
  thread(CAMP, { title: "Launch", goal: "Ship the launch", origin: { threadId: CHAT, chapterId: null }, ...fields });

const message = (threadId: ThreadId, id: string, role: Message["role"], fields: Partial<Message> = {}) =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role,
    content: id,
    status: "complete",
    error: null,
    configVersion: role === "user" ? null : (1 as Message["configVersion"]),
    createdAt: tick(),
    ...fields,
  });

/** A reply that wrote a file, which the artifacts registry keeps. */
const writing = (threadId: ThreadId, id: string, path: string) =>
  message(threadId, id, "assistant", {
    steps: [
      {
        id: `${id}-step`,
        kind: "tool",
        label: `Writing ${path}`,
        state: "done",
        call: { tool: "Write", operation: "edit-files", targets: [path] },
      },
    ],
  });

const newTask = (id: string, parentId: string | null, threadId: ThreadId = CHAT): NewTask => ({
  id: TaskId.make(id),
  ownerId: ALDRIC,
  parentId: parentId === null ? null : TaskId.make(parentId),
  threadId,
  brief: `Brief for ${id}`,
  dependsOn: [],
  createdAt: tick(),
});

/** A decision you recorded in the app, which joins the thread's live chapter. */
const decide = (threadId: ThreadId, id: string) =>
  Effect.gen(function* () {
    const records = yield* RecordRepository;
    return yield* records.recordDecision({
      id: DecisionId.make(id),
      threadId,
      sourceMessageId: null,
      text: `Decision ${id}`,
      replaces: null,
      actor: OWNER_ACTOR,
      key: `app:${id}`,
      input: id,
      at: tick(),
    });
  });

/** A Quest started in the thread's live chapter, with a question waiting and a failed step. */
const quest = (id: string, threadId: ThreadId = CHAT) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    yield* tasks.createTask({ task: newTask(id, null, threadId), delegation: null, milestones: [] });
    const started = yield* tasks.startQuest({
      id: QuestId.make(`${id}-quest`),
      taskId: TaskId.make(id),
      goal: `Do ${id}`,
      acceptance: [],
      limits: DEFAULT_QUEST_LIMITS,
      createdAt: NOW,
    });
    return started;
  });

/**
 * Aldric's chat with two chapters: the first holds a question and a reply that wrote launch.md, a
 * decision and a Quest with a question waiting for you and a failed step; the second, live, holds a
 * question and a reply and a decision of its own.
 */
const chatWithTwoChapters = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const chapters = yield* ChapterRepository;
  const tasks = yield* TaskRepository;
  yield* repo.insertAgent(hob(ALDRIC, "Aldric"));
  yield* repo.upsertThread(thread(CHAT, { title: "Chat", kind: "chat" }));
  yield* repo.upsertMessage(message(CHAT, "ask-1", "user"));
  yield* repo.upsertMessage(writing(CHAT, "reply-1", "/work/app/launch.md"));
  yield* decide(CHAT, "d1");
  yield* quest("launch");
  yield* tasks.askQuestion({
    id: QuestionId.make("which"),
    taskId: TaskId.make("launch"),
    askerId: ALDRIC,
    text: "Which lamps first?",
    createdAt: NOW,
  });
  const step = yield* tasks.createTask({ task: newTask("wire", "launch"), delegation: null, milestones: [] });
  yield* tasks.moveTask(step.value.id, step.value.revision, "failed", NOW);
  const [first] = yield* chapters.listChapters(CHAT);
  yield* chapters.startChapter(CHAT, { id: ChapterId.make("billing"), title: "Billing", at: tick() });
  yield* repo.upsertMessage(message(CHAT, "ask-2", "user"));
  yield* repo.upsertMessage(message(CHAT, "reply-2", "assistant"));
  yield* decide(CHAT, "d2");
  return { first: (first as { id: ChapterId }).id, billing: ChapterId.make("billing") };
});

/** Where each record is now, by table: its id and thread, in id order. */
const placesOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = (table: string, id = "id") =>
    sql<{ id: string; threadId: string | null }>`SELECT ${sql(id)} AS id, thread_id FROM ${sql(table)} ORDER BY id`;
  return {
    messages: yield* rows("messages"),
    decisions: yield* rows("decisions"),
    artifacts: yield* rows("artifacts"),
    tasks: yield* rows("tasks"),
    quests: yield* rows("quests"),
    items: yield* rows("backpack_items"),
  };
});

const intoNew = (fields: Partial<Thread> = {}): ChapterMoveTarget => ({ _tag: "new", camp: newCamp(fields) });
const intoCamp = (campId: ThreadId): ChapterMoveTarget => ({ _tag: "camp", campId });

const move = (chapterId: ChapterId, target: ChapterMoveTarget, threadId: ThreadId = CHAT) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    return yield* repo.moveChapter({ threadId, chapterId, target, at: LATER });
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

const idsIn = (rows: ReadonlyArray<{ id: string; threadId: string | null }>, threadId: ThreadId) =>
  rows.filter((row) => row.threadId === threadId).map((row) => row.id);

describe("moving a chapter into a camp", () => {
  // covers CH-009, ADR 037 (Moving a chapter into a camp moves it)
  it("[TC-CH-1385-01] moves a resting chapter's messages, records and quests into a new camp once, and leaves a stub", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { first } = yield* chatWithTwoChapters;
        const repo = yield* HobbotsRepository;
        const chapters = yield* ChapterRepository;
        const before = yield* placesOf;
        const moved = yield* move(first, intoNew());
        const again = yield* move(first, intoNew());
        return {
          first,
          before,
          moved,
          again,
          after: yield* placesOf,
          chat: yield* chapters.listChapters(CHAT),
          camp: yield* chapters.listChapters(CAMP),
          campMessages: yield* repo.listMessages(CAMP),
          chatMessages: yield* repo.listMessages(CHAT),
          campWork: yield* repo.listOpenWork(CAMP),
          chatWork: yield* repo.listOpenWork(CHAT),
        };
      }),
    );
    // One transaction: the camp is made, then the move, then each moved backpack item.
    expect(result.moved.entries.map((entry) => entry.type)).toEqual([
      "CampMade",
      "ChapterStarted",
      "ChapterMoved",
      ...result.moved.entries.slice(3).map(() => "BackpackItemChanged"),
    ]);
    expect(result.moved.entries.length).toBeGreaterThan(3);
    // The chat keeps the chapter as a stub that links to the camp; the camp's first chapter holds it.
    const stub = result.chat.find((chapter) => chapter.id === result.first);
    expect(stub).toMatchObject({ state: "moved", movedTo: CAMP, number: 1 });
    expect(result.chat.map((chapter) => chapter.state)).toEqual(["moved", "live"]);
    expect(result.camp).toHaveLength(1);
    expect(ChapterStates.isLive(result.camp[0] as never)).toBe(true);
    expect(result.campMessages.map((m) => [m.id, m.chapterId])).toEqual([
      ["ask-1", result.camp[0]?.id],
      ["reply-1", result.camp[0]?.id],
    ]);
    expect(result.chatMessages.map((m) => m.id)).toEqual(["ask-2", "reply-2"]);
    // Nothing is copied: every record is still there once, in the one place it now belongs.
    const count = (places: typeof result.before) => Object.values(places).map((rows) => rows.length);
    expect(count(result.after)).toEqual(count(result.before));
    expect(idsIn(result.after.decisions, CAMP)).toEqual(["d1"]);
    expect(idsIn(result.after.decisions, CHAT)).toEqual(["d2"]);
    expect(idsIn(result.after.artifacts, CHAT)).toEqual([]);
    expect(idsIn(result.after.artifacts, CAMP)).toHaveLength(1);
    expect(idsIn(result.after.tasks, CAMP)).toEqual(["launch", "wire"]);
    expect(idsIn(result.after.quests, CAMP)).toEqual(["launch-quest"]);
    expect(idsIn(result.after.tasks, CHAT)).toEqual([]);
    expect(idsIn(result.after.items, CHAT)).toEqual([]);
    // The question waiting in the quest went with it.
    expect(result.campWork.questions.map((question) => question.id)).toEqual(["which"]);
    expect(result.chatWork.questions).toEqual([]);
    // Asked again, it answers what it did and journals nothing.
    expect(result.again.entries).toEqual([]);
    expect(result.again.value.stub).toEqual(result.moved.value.stub);
    expect(result.moved.value.camp).toMatchObject({ id: CAMP, kind: "camp", origin: { threadId: CHAT } });
  });

  // covers CH-009, ADR 037 (Moving a chapter into a camp moves it)
  it("[TC-CH-1385-02] moves the live chapter into a camp with messages of its own, which goes on with it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { billing } = yield* chatWithTwoChapters;
        const repo = yield* HobbotsRepository;
        const chapters = yield* ChapterRepository;
        yield* repo.makeCamp(newCamp());
        yield* repo.upsertMessage(message(CAMP, "camp-ask", "user"));
        const moved = yield* move(billing, intoCamp(CAMP));
        // The chat's next message joins the chapter that took the moved one's place.
        const next = (yield* repo.upsertMessage(message(CHAT, "ask-3", "user"))).value;
        return {
          moved,
          next,
          chat: yield* chapters.listChapters(CHAT),
          camp: yield* chapters.listChapters(CAMP),
          campMessages: yield* repo.listMessages(CAMP),
          chatThread: Option.getOrThrow(yield* repo.findThread(CHAT)),
          campThread: Option.getOrThrow(yield* repo.findThread(CAMP)),
        };
      }),
    );
    expect(result.moved.entries.map((entry) => entry.type)).toEqual(["ChapterMoved"]);
    expect(result.chat.map((chapter) => [chapter.number, chapter.state])).toEqual([
      [1, "resting"],
      [2, "moved"],
      [3, "live"],
    ]);
    expect(result.chatThread.liveChapterId).toBe(result.chat[2]?.id);
    expect(result.next.chapterId).toBe(result.chat[2]?.id);
    // The camp's own topic rests, and the moved one goes on as its live chapter, after it.
    expect(result.camp.map((chapter) => [chapter.number, chapter.state, chapter.title])).toEqual([
      [1, "resting", null],
      [2, "live", "Billing"],
    ]);
    expect(result.campThread.liveChapterId).toBe(result.camp[1]?.id);
    expect(result.campMessages.map((m) => [m.id, m.chapterId === result.camp[1]?.id])).toEqual([
      ["camp-ask", false],
      ["ask-2", true],
      ["reply-2", true],
    ]);
  });

  // covers CH-009, ADR 037 (Moving a chapter into a camp moves it)
  it("[TC-CH-1385-03] leaves nothing moved and no camp made when the move fails midway through its writes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { first } = yield* chatWithTwoChapters;
        const repo = yield* HobbotsRepository;
        const chapters = yield* ChapterRepository;
        const before = yield* placesOf;
        const chaptersBefore = yield* chapters.listChapters(CHAT);
        const clear = yield* breakNextAppend;
        const failed = yield* Effect.exit(move(first, intoNew()));
        yield* clear;
        const after = yield* placesOf;
        const chaptersAfter = yield* chapters.listChapters(CHAT);
        const camp = yield* repo.findThread(CAMP);
        // Once the journal takes writes again, the same move goes through whole.
        const retried = yield* move(first, intoNew());
        return { failed, before, after, chaptersBefore, chaptersAfter, camp, retried };
      }),
    );
    expect(Exit.isFailure(result.failed)).toBe(true);
    expect(result.after).toEqual(result.before);
    expect(result.chaptersAfter).toEqual(result.chaptersBefore);
    expect(Option.isNone(result.camp)).toBe(true);
    expect(result.retried.value.stub).toMatchObject({ state: "moved", movedTo: CAMP });
  });

  // covers CH-009, ADR 037 (Moving a chapter into a camp moves it)
  it("[TC-CH-1385-04] refuses a move into the same thread, a chat, another hob's camp or a closed camp, and a chapter moved already", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { first, billing } = yield* chatWithTwoChapters;
        const repo = yield* HobbotsRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.insertAgent(hob(AgentId.make("bo"), "Bo"));
        yield* repo.upsertThread(thread(ThreadId.make("bo-camp"), { agentId: AgentId.make("bo") }));
        yield* repo.upsertThread(thread(ThreadId.make("old-camp"), { state: "archived", archivedAt: NOW }));
        yield* repo.makeCamp(newCamp());
        const refused = (chapterId: ChapterId, target: ChapterMoveTarget) =>
          move(chapterId, target).pipe(
            Effect.match({
              onFailure: (error) => ("reason" in error ? error.reason : error._tag),
              onSuccess: () => "moved through",
            }),
          );
        const reasons = {
          same: yield* refused(first, intoCamp(CHAT)),
          otherHob: yield* refused(first, intoCamp(ThreadId.make("bo-camp"))),
          closed: yield* refused(first, intoCamp(ThreadId.make("old-camp"))),
          missing: yield* refused(first, intoCamp(ThreadId.make("nowhere"))),
        };
        // A reply under way holds the chat's chapters where they are.
        yield* sql`UPDATE messages SET status = 'streaming' WHERE id = 'reply-2'`;
        const running = yield* refused(first, intoCamp(CAMP));
        yield* sql`UPDATE messages SET status = 'complete' WHERE id = 'reply-2'`;
        yield* move(first, intoCamp(CAMP));
        const elsewhere = yield* refused(first, intoNew({ id: ThreadId.make("camp-2") }));
        // The chat's live chapter, once moved, leaves an empty one in its place, which does not move.
        yield* move(billing, intoCamp(CAMP));
        const live = Option.getOrThrow(yield* repo.findThread(CHAT)).liveChapterId as ChapterId;
        const empty = yield* refused(live, intoCamp(CAMP));
        return { reasons, running, elsewhere, empty };
      }),
    );
    expect(result.reasons).toEqual({
      same: "same-thread",
      otherHob: "not-a-camp",
      closed: "not-a-camp",
      missing: "not-a-camp",
    });
    expect(result.running).toBe("reply-running");
    expect(result.elsewhere).toBe("moved");
    expect(result.empty).toBe("live-chapter-empty");
  });
});

describe("camp suggestions", () => {
  const suggested = (entries: ReadonlyArray<{ type: string; payload: unknown }>) =>
    entries
      .filter((entry) => entry.type === "CampSuggested")
      .map((entry) => (entry.payload as { suggestion: CampSuggestion }).suggestion);

  // covers CH-009, ADR 037 (Records: CampSuggestion)
  it("[TC-CH-1385-05] raises one suggestion when a chat chapter reaches a threshold, and never again once kept", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const suggestions = yield* CampSuggestionRepository;
        yield* repo.insertAgent(hob(ALDRIC, "Aldric"));
        yield* repo.upsertThread(thread(CHAT, { title: "Chat", kind: "chat" }));
        const raised: Array<ReadonlyArray<CampSuggestion>> = [];
        for (let n = 1; n <= CAMP_SUGGESTION_DECISIONS + 1; n++) {
          raised.push(suggested((yield* decide(CHAT, `d${n}`)).entries));
        }
        const open = yield* suggestions.listOpen(CHAT);
        const suggestion = open[0] as CampSuggestion;
        const kept = yield* suggestions.keep(CHAT, suggestion.id, LATER);
        const keptAgain = yield* suggestions.keep(CHAT, suggestion.id, LATER);
        const afterKeep = suggested((yield* decide(CHAT, "d-more")).entries);
        // A camp's chapters are never suggested: they are a camp already.
        yield* repo.makeCamp(newCamp());
        const inCamp: Array<CampSuggestion> = [];
        for (let n = 1; n <= CAMP_SUGGESTION_DECISIONS; n++)
          inCamp.push(...suggested((yield* decide(CAMP, `c${n}`)).entries));
        const missing = yield* Effect.exit(suggestions.keep(CHAT, "nope" as CampSuggestion["id"], LATER));
        return {
          raised,
          open,
          kept,
          keptAgain,
          afterKeep,
          inCamp,
          missing,
          openAfter: yield* suggestions.listOpen(CHAT),
        };
      }),
    );
    // Only the decision that reached the threshold raised it, in its own transaction.
    expect(result.raised.map((each) => each.length)).toEqual([0, 0, 0, 0, 1, 0]);
    expect(result.raised[CAMP_SUGGESTION_DECISIONS - 1]?.[0]).toMatchObject({
      threadId: CHAT,
      state: "open",
      reasons: [{ code: "decisions", count: CAMP_SUGGESTION_DECISIONS }],
    });
    expect(result.open).toHaveLength(1);
    expect(result.kept.entries.map((entry) => entry.type)).toEqual(["CampSuggestionKept"]);
    expect(result.kept.value).toMatchObject({ state: "kept", settledAt: LATER });
    expect(result.keptAgain.entries).toEqual([]);
    expect(result.afterKeep).toEqual([]);
    expect(result.openAfter).toEqual([]);
    expect(result.inCamp).toEqual([]);
    expect(result.missing).toMatchObject(Exit.fail({ _tag: "CampSuggestionRefused", reason: "not-found" }));
  });

  // covers CH-009, ADR 037 (Records: CampSuggestion)
  it("[TC-CH-1385-06] accepts a chapter's suggestion when it moves, and expires one whose chapter is merged away or whose chat closes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { billing } = yield* chatWithTwoChapters;
        const repo = yield* HobbotsRepository;
        const chapters = yield* ChapterRepository;
        const suggestions = yield* CampSuggestionRepository;
        // A second Quest in the live chapter reaches the quests threshold.
        const raisedBy: Array<string> = [];
        for (let n = 1; n <= CAMP_SUGGESTION_QUESTS; n++) {
          const started = yield* quest(`billing-${n}`);
          raisedBy.push(...suggested(started.entries).map((each) => each.reasons.map((r) => r.code).join()));
        }
        const [open] = yield* suggestions.listOpen(CHAT);
        const moved = yield* move(billing, intoNew());
        const keepAccepted = yield* Effect.exit(suggestions.keep(CHAT, (open as CampSuggestion).id, LATER));

        // Merged away: the chat's next chapter gets a suggestion, then merges into the one before it.
        const live = Option.getOrThrow(yield* repo.findThread(CHAT)).liveChapterId as ChapterId;
        yield* repo.upsertMessage(message(CHAT, "ask-4", "user"));
        yield* chapters.startChapter(CHAT, { id: ChapterId.make("late"), title: "Late", at: tick() });
        yield* repo.upsertMessage(message(CHAT, "ask-5", "user"));
        for (let n = 1; n <= CAMP_SUGGESTION_DECISIONS; n++) yield* decide(CHAT, `late-${n}`);
        const merged = yield* chapters.mergeChapters(CHAT, ChapterId.make("late"));

        // Closed: a suggestion in the merged chapter, then the chat is archived.
        for (let n = 1; n <= CAMP_SUGGESTION_DECISIONS; n++) yield* decide(CHAT, `more-${n}`);
        const beforeArchive = yield* suggestions.listOpen(CHAT);
        const chat = Option.getOrThrow(yield* repo.findThread(CHAT));
        const archived = yield* repo.upsertThread(new Thread({ ...chat, state: "archived", archivedAt: LATER }));
        return { raisedBy, open, moved, keepAccepted, live, merged, beforeArchive, archived };
      }),
    );
    expect(result.raisedBy).toEqual(["quests"]);
    expect(result.open).toMatchObject({ chapterId: "billing", state: "open" });
    const accepted = result.moved.entries.find((entry) => entry.type === "CampSuggestionAccepted");
    expect((accepted as { payload: { suggestion: CampSuggestion } }).payload.suggestion).toMatchObject({
      state: "accepted",
      campId: CAMP,
    });
    expect(result.keepAccepted).toMatchObject(Exit.fail({ _tag: "CampSuggestionRefused", reason: "settled" }));
    expect(result.merged.entries.map((entry) => entry.type)).toEqual(["ChapterMerged", "CampSuggestionExpired"]);
    expect(result.beforeArchive).toHaveLength(1);
    expect(result.archived.entries.map((entry) => entry.type)).toEqual(["ThreadUpserted", "CampSuggestionExpired"]);
  });

  /**
   * A chat whose first chapter holds a Quest whose step completed with `files`, then a camp whose own
   * replies wrote the same files, and a second chapter in the chat, so the first rests and can move.
   */
  const deliveredThenCamp = (files: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const tasks = yield* TaskRepository;
      const chapters = yield* ChapterRepository;
      yield* repo.insertAgent(hob(ALDRIC, "Aldric"));
      yield* repo.upsertThread(thread(CHAT, { title: "Chat", kind: "chat" }));
      yield* repo.upsertMessage(message(CHAT, "ask-1", "user"));
      yield* quest("ship");
      const step = yield* tasks.createTask({ task: newTask("copy", "ship"), delegation: null, milestones: [] });
      const attemptId = AttemptId.make("copy-attempt");
      const started = yield* tasks.startAttempt(step.value.id, step.value.revision, {
        id: attemptId,
        runtime: "claude-code",
        sessionId: null,
        configVersion: 1,
        policyVersion: null,
        startedAt: tick(),
      });
      const ledger = yield* tasks.readLedger(step.value.id);
      yield* tasks.completeTask(step.value.id, started.value.task.revision, {
        summary: "Done",
        attemptId,
        artifacts: files.map((value, n) => ({
          id: ArtifactId.make(`copy-${n}`),
          kind: "file" as const,
          label: "",
          value,
        })),
        at: tick(),
        carried: Option.isSome(ledger) ? carriedFrom(ledger.value, () => true) : [],
      });
      const [first] = yield* chapters.listChapters(CHAT);
      yield* chapters.startChapter(CHAT, { id: ChapterId.make("next"), title: "Next", at: tick() });
      yield* repo.makeCamp(newCamp());
      for (const [n, file] of files.entries()) yield* repo.upsertMessage(writing(CAMP, `camp-reply-${n}`, file));
      return (first as { id: ChapterId }).id;
    });

  const reviewIn = (threadId: ThreadId, locator: string, outcome: "reviewed" | "dismissed") =>
    Effect.gen(function* () {
      const records = yield* RecordRepository;
      const artifact = (yield* records.listArtifacts(threadId)).find((each) => each.locator === locator);
      if (artifact === undefined) return yield* Effect.die(new Error(`No ${locator} in ${threadId}`));
      return yield* records.reviewArtifact({ threadId, artifactId: artifact.id, outcome, by: OWNER_ACTOR, at: tick() });
    });

  const readyOf = Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const all = [...(yield* tasks.listQuestSummaries(CHAT)), ...(yield* tasks.listQuestSummaries(CAMP))];
    return all.find((summary) => summary.questId === "ship-quest")?.readyForReview;
  });

  // covers ADR 037 (Quests in camps, Records), STD-ARCH-014
  it("[TC-CH-1422-07] recounts a Quest's ready-for-review in the move whose artifact joins one the camp reviewed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* deliveredThenCamp(["/work/app/plan.md"]);
        yield* reviewIn(CAMP, "/work/app/plan.md", "reviewed");
        const before = yield* readyOf;
        const moved = yield* move(first, intoCamp(CAMP));
        const records = yield* RecordRepository;
        return {
          before,
          types: moved.entries.map((entry) => entry.type),
          after: yield* readyOf,
          camp: (yield* records.listArtifacts(CAMP)).map((each) => [each.locator, each.review]),
        };
      }),
    );
    expect(result.before).toBe(1);
    // The plan is one artifact in the camp now, reviewed there, so nothing waits.
    expect(result.camp).toEqual([["/work/app/plan.md", "reviewed"]]);
    expect(result.types).toContain("QuestSummaryChanged");
    expect(result.after).toBe(0);
  });

  // covers ADR 037 (Records), STD-DATA-001, STD-ARCH-019
  it("[TC-CH-1422-08] keeps a review settled in the chat when its artifact joins the camp's, and the camp's own when both settled", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* deliveredThenCamp(["/work/app/notes.md", "/work/app/page.html"]);
        const notes = (yield* reviewIn(CHAT, "/work/app/notes.md", "reviewed")).value;
        yield* reviewIn(CHAT, "/work/app/page.html", "dismissed");
        const page = (yield* reviewIn(CAMP, "/work/app/page.html", "reviewed")).value;
        const moved = yield* move(first, intoCamp(CAMP));
        const records = yield* RecordRepository;
        return {
          notes,
          page,
          settled: moved.entries.filter((entry) => entry.type === "ArtifactReviewSettled"),
          camp: yield* records.listArtifacts(CAMP),
          after: yield* readyOf,
        };
      }),
    );
    const byLocator = new Map(result.camp.map((each) => [each.locator, each]));
    // The chat's review of the notes is carried over, as made, and journaled with the move.
    expect(byLocator.get("/work/app/notes.md")).toMatchObject({
      review: "reviewed",
      reviewedAt: result.notes.reviewedAt,
      reviewedBy: OWNER_ACTOR,
    });
    expect(result.settled).toHaveLength(1);
    // Both settled: the camp's review is final and stays.
    expect(byLocator.get("/work/app/page.html")).toMatchObject({
      review: "reviewed",
      reviewedAt: result.page.reviewedAt,
    });
    expect(result.camp).toHaveLength(2);
    expect(result.after).toBe(0);
  });
});
