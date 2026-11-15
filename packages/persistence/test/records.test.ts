import { ChapterRepository, type DecisionRequest, HobbotsRepository, RecordRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  ChapterId,
  DECISION_TEXT_MAX,
  DecisionId,
  DecisionStates,
  FileChange,
  FileChangeId,
  type JournaledEvent,
  Message,
  MessageId,
  OWNER_ACTOR,
  roleFields,
  Task,
  TaskId,
  Channel,
  ChannelId,
} from "@hobbots/domain";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  ChapterRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  migrations,
  RecordRepositoryLive,
} from "../src/index.ts";
import { makeJournaledChange } from "../src/journal.ts";
import recordsMigration from "../src/migrations/0101_records.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1383 (ADR 037, Records): decisions are recorded, replaced and crossed out, kept for good,
// each in one transaction with its journal entry; the artifacts registry keeps each thing a hob made
// once, at its latest version, whatever record saw it; every message names its author. On SQLite
// and PostgreSQL alike.

const NOW = "2026-11-12T00:00:00.000Z";
const ADA = AgentId.make("ada");
const CHANNEL = ChannelId.make("t1");
const REPLY = MessageId.make("reply-1");
const TASK = TaskId.make("task-1");
const ATTEMPT = AttemptId.make("attempt-1");

const hob = new Agent({
  id: ADA,
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

const message = (id: string, role: Message["role"], fields: Partial<Message> = {}) =>
  new Message({
    id: MessageId.make(id),
    channelId: CHANNEL,
    actor: role === "assistant" ? null : OWNER_ACTOR,
    role,
    content: id,
    status: "complete",
    error: null,
    configVersion: role === "user" ? null : (1 as Message["configVersion"]),
    createdAt: NOW,
    ...fields,
  });

const layer = Layer.mergeAll(
  HobbotsRepositoryLive,
  RecordRepositoryLive,
  ChapterRepositoryLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | RecordRepository | ChapterRepository | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, E>);

/** A hob, its camp, a message of yours and the hob's reply, stored as the hub stores them. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(hob);
  yield* repo.upsertChannel(new Channel({ id: CHANNEL, agentId: ADA, title: "Launch", createdAt: NOW, updatedAt: NOW }));
  const yours = (yield* repo.upsertMessage(message("ask-1", "user"))).value;
  const reply = (yield* repo.upsertMessage(message(REPLY, "assistant", { status: "streaming" }))).value;
  return { yours, reply };
});

const request = (fields: Partial<DecisionRequest> = {}): DecisionRequest => ({
  id: DecisionId.make(fields.id ?? "d1"),
  channelId: CHANNEL,
  sourceMessageId: REPLY,
  text: "Launch emails go out on Tuesdays.",
  replaces: null,
  actor: { kind: "hob", id: ADA },
  key: `reply:${fields.id ?? "d1"}`,
  input: fields.text ?? "Launch emails go out on Tuesdays.",
  at: NOW,
  ...fields,
});

describe("decisions", () => {
  // covers ADR 037 (Records)
  it("keeps a replaced decision crossed out in the record and out of the active ones (#1383)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { reply } = yield* seed;
        const records = yield* RecordRepository;
        const first = yield* records.recordDecision(request());
        const second = yield* records.recordDecision(
          request({
            id: DecisionId.make("d2"),
            text: "Launch emails go out on Wednesdays.",
            replaces: first.value.recorded.id,
          }),
        );
        const all = yield* records.listDecisions(CHANNEL);
        return { reply, first, second, all };
      }),
    );
    expect(result.first.value.recorded).toMatchObject({
      id: "d1",
      chapterId: result.reply.chapterId,
      sourceMessageId: REPLY,
      actor: { kind: "hob", id: ADA },
      state: "active",
    });
    expect(result.first.entries.map((entry) => [entry.type, entry.correlation])).toEqual([
      ["DecisionRecorded", { agentId: ADA, channelId: CHANNEL, messageId: REPLY }],
    ]);
    // Recording the new one crosses out the old in the same transaction, journaled after it.
    expect(result.second.entries.map((entry) => entry.type)).toEqual(["DecisionRecorded", "DecisionSuperseded"]);
    expect(result.second.entries.map((entry) => entry.sequence)).toEqual([
      result.second.value.recorded.revision,
      result.second.value.superseded?.revision,
    ]);
    // Both are kept, newest first; the old one is crossed out with its text unchanged.
    expect(result.all.map((decision) => [decision.id, decision.state, decision.supersededBy, decision.text])).toEqual([
      ["d2", "active", null, "Launch emails go out on Wednesdays."],
      ["d1", "superseded", "d2", "Launch emails go out on Tuesdays."],
    ]);
    expect(result.all.filter(DecisionStates.isActive).map((decision) => decision.id)).toEqual(["d2"]);
  });

  // covers ADR 037 (Records)
  it("records a retried key once, refuses it for another decision, and refuses a text over the limit (#1383)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const records = yield* RecordRepository;
        const first = yield* records.recordDecision(request());
        const again = yield* records.recordDecision(request({ id: DecisionId.make("d-retry"), key: "reply:d1" }));
        const reused = yield* Effect.exit(
          records.recordDecision(request({ id: DecisionId.make("d3"), key: "reply:d1", input: "Another." })),
        );
        const long = yield* Effect.exit(
          records.recordDecision(
            request({ id: DecisionId.make("d4"), key: "reply:d4", text: "x".repeat(DECISION_TEXT_MAX + 1) }),
          ),
        );
        return { first, again, reused, long, all: yield* records.listDecisions(CHANNEL) };
      }),
    );
    expect(result.again.value.recorded.id).toBe(result.first.value.recorded.id);
    expect(result.again.entries).toEqual([]);
    expect(result.reused).toMatchObject(Exit.fail({ _tag: "DecisionRefused", reason: "key-reused" }));
    expect(result.long).toMatchObject(Exit.fail({ _tag: "DecisionRefused", reason: "too-long" }));
    expect(result.all.map((decision) => decision.id)).toEqual(["d1"]);
  });

  // covers ADR 037 (Records)
  it("crosses a decision out once, by you, and takes no decision in a closed camp (#1383)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { yours } = yield* seed;
        const records = yield* RecordRepository;
        const sql = yield* SqlClient.SqlClient;
        const mine = yield* records.recordDecision(
          request({
            sourceMessageId: null,
            actor: OWNER_ACTOR,
            key: "app:d1",
            text: "Ship on Friday.",
            input: "Ship on Friday.",
          }),
        );
        const crossed = yield* records.crossOutDecision({
          channelId: CHANNEL,
          decisionId: mine.value.recorded.id,
          at: NOW,
        });
        const again = yield* records.crossOutDecision({
          channelId: CHANNEL,
          decisionId: mine.value.recorded.id,
          at: NOW,
        });
        const missing = yield* Effect.exit(
          records.crossOutDecision({ channelId: CHANNEL, decisionId: DecisionId.make("nope"), at: NOW }),
        );
        yield* sql`UPDATE channels SET state = 'archived' WHERE id = ${CHANNEL}`;
        const closed = yield* Effect.exit(
          records.recordDecision(request({ id: DecisionId.make("d9"), key: "reply:d9" })),
        );
        return { yours, mine, crossed, again, missing, closed };
      }),
    );
    // One you record joins the live chapter, with you as its actor.
    expect(result.mine.value.recorded).toMatchObject({ chapterId: result.yours.chapterId, actor: OWNER_ACTOR });
    expect(result.crossed.value).toMatchObject({ state: "superseded", supersededBy: null, supersededAt: NOW });
    expect(result.crossed.entries.map((entry) => entry.type)).toEqual(["DecisionSuperseded"]);
    expect(result.again.entries).toEqual([]);
    expect(result.missing).toMatchObject(Exit.fail({ _tag: "DecisionRefused", reason: "not-found" }));
    expect(result.closed).toMatchObject(Exit.fail({ _tag: "DecisionRefused", reason: "channel-closed" }));
  });

  // covers ADR 037 (Records), STD-ARCH-014
  it("takes the same key in another channel as a new request, recording a decision there too (#1383)", async () => {
    const other = ChannelId.make("t2");
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* HobbotsRepository;
        const records = yield* RecordRepository;
        yield* repo.upsertChannel(
          new Channel({ id: other, agentId: ADA, title: "Other", createdAt: NOW, updatedAt: NOW }),
        );
        yield* repo.upsertMessage(message("ask-2", "user", { channelId: other }));
        const yours = { sourceMessageId: null, actor: OWNER_ACTOR, key: "app:same" };
        const here = yield* records.recordDecision(request(yours));
        const there = yield* records.recordDecision(request({ ...yours, id: DecisionId.make("d2"), channelId: other }));
        return { here, there, inOther: yield* records.listDecisions(other) };
      }),
    );
    expect(result.here.value.recorded).toMatchObject({ id: "d1", channelId: CHANNEL });
    expect(result.there.value.recorded).toMatchObject({ id: "d2", channelId: other });
    expect(result.there.entries.map((entry) => entry.type)).toEqual(["DecisionRecorded"]);
    expect(result.inOther.map((decision) => decision.id)).toEqual(["d2"]);
  });

  // covers ADR 037 (Chapters, Records), STD-ARCH-019
  it("moves a chapter's decisions and artifacts with its messages when it is split or merged (#1383)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { reply } = yield* seed;
        const repo = yield* HobbotsRepository;
        const records = yield* RecordRepository;
        const chapters = yield* ChapterRepository;
        const first = reply.chapterId as ChapterId;
        const [c2, c3] = [ChapterId.make("c2"), ChapterId.make("c3")];
        yield* chapters.startChapter(CHANNEL, { id: c2, title: "Emails", at: NOW });
        yield* repo.upsertMessage(message("ask-2", "user"));
        const later = (yield* repo.upsertMessage(message("reply-2", "assistant", { status: "streaming" }))).value;
        yield* records.recordDecision(request({ id: DecisionId.make("d-hob"), sourceMessageId: later.id }));
        yield* records.recordDecision(
          request({ id: DecisionId.make("d-app"), sourceMessageId: null, actor: OWNER_ACTOR, key: "app:d" }),
        );
        yield* repo.upsertMessage(
          new Message({
            ...later,
            status: "complete",
            steps: [
              {
                id: "s1",
                kind: "tool",
                label: "Writing launch.md",
                state: "done",
                call: { tool: "Write", operation: "edit-files", targets: ["/work/app/launch.md"] },
              },
            ],
          }),
        );
        const where = Effect.gen(function* () {
          const decisions = yield* records.listDecisions(CHANNEL);
          const artifacts = yield* records.listArtifacts(CHANNEL);
          return [
            ...decisions.map((decision) => [decision.id, decision.chapterId]),
            ...artifacts.map((artifact) => [artifact.locator, artifact.chapterId]),
          ];
        });
        const before = yield* where;
        yield* chapters.splitChapter(CHANNEL, { id: c3, messageId: later.id, title: "Reply" });
        const split = yield* where;
        yield* chapters.mergeChapters(CHANNEL, c3);
        const mergedBack = yield* where;
        yield* chapters.mergeChapters(CHANNEL, c2);
        return { first, before, split, mergedBack, merged: yield* where };
      }),
    );
    const placed = (hob: string, app: string, artifact: string) => [
      ["d-app", app],
      ["d-hob", hob],
      ["/work/app/launch.md", artifact],
    ];
    expect(result.before).toEqual(placed("c2", "c2", "c2"));
    // A split takes the records of the replies it moves, and leaves the rest.
    expect(result.split).toEqual(placed("c3", "c2", "c3"));
    // A merge takes all of the absorbed chapter's records, which no longer blocks it.
    expect(result.mergedBack).toEqual(placed("c2", "c2", "c2"));
    expect(result.merged).toEqual(placed(result.first, result.first, result.first));
  });
});

describe("artifacts", () => {
  const file = "/work/app/launch.md";

  /** Journals `events` as one change, as a repository would after its own write. */
  const journal = (events: ReadonlyArray<JournaledEvent>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* makeJournaledChange(sql)<null, never>(() => Effect.succeed({ value: null, events }));
    });

  const completed: JournaledEvent = {
    _tag: "TaskCompleted",
    task: new Task({
      id: TASK,
      ownerId: ADA,
      parentId: null,
      rootId: TASK,
      channelId: CHANNEL,
      brief: "Plan the launch",
      state: "completed",
      dependsOn: [],
      result: { summary: "Planned", attemptId: ATTEMPT },
      currentAttemptId: ATTEMPT,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    artifacts: [
      new ArtifactRef({
        id: ArtifactId.make("ref-1"),
        taskId: TASK,
        attemptId: ATTEMPT,
        kind: "file",
        label: "Launch plan",
        value: file,
        createdAt: NOW,
      }),
    ],
  };
  const changed: JournaledEvent = {
    _tag: "FileChangesRecorded",
    attemptId: ATTEMPT,
    taskId: TASK,
    folder: "/work/app",
    changes: [
      new FileChange({
        id: FileChangeId.make("change-1"),
        attemptId: ATTEMPT,
        taskId: TASK,
        folder: "/work/app",
        path: "launch.md",
        kind: "edited",
        movedFrom: null,
        before: null,
        after: { hash: "h", size: 1, kind: "text", contentId: null, notKept: null },
        sharedWith: [],
        settled: true,
        recordedAt: NOW,
      }),
    ],
    removed: [],
  };

  // covers ADR 037 (Records)
  it("keeps each artifact once at its latest version, whatever record made it, and a record twice counts once (#1383)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { reply } = yield* seed;
        const repo = yield* HobbotsRepository;
        const records = yield* RecordRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO tasks ${sql.insert({
          id: TASK,
          owner_id: ADA,
          root_id: TASK,
          channel_id: CHANNEL,
          brief: "Plan the launch",
          state: "active",
          created_at: NOW,
          updated_at: NOW,
        })}`;
        const byChange = yield* journal([changed]);
        const byResult = yield* journal([completed]);
        // The reply's turn ends with a step that wrote the same file.
        const done = new Message({
          ...reply,
          status: "complete",
          steps: [
            {
              id: "s1",
              kind: "tool",
              label: "Writing launch.md",
              state: "done",
              call: { tool: "Write", operation: "edit-files", targets: [file] },
            },
          ],
        });
        const byReply = yield* repo.upsertMessage(done);
        // The same records again register nothing new.
        const replayed = [yield* journal([changed, completed]), yield* repo.upsertMessage(done)];
        return { reply, byChange, byResult, byReply, replayed, artifacts: yield* records.listArtifacts(CHANNEL) };
      }),
    );
    const registered = (entries: ReadonlyArray<{ readonly type: string }>) =>
      entries.filter((entry) => entry.type === "ArtifactRegistered").length;
    expect([result.byChange, result.byResult, result.byReply].map((change) => registered(change.entries))).toEqual([
      1, 1, 1,
    ]);
    expect(result.replayed.map((change) => registered(change.entries))).toEqual([0, 0]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      channelId: CHANNEL,
      chapterId: result.reply.chapterId,
      locator: file,
      kind: "doc",
      title: "Launch plan",
      // The result the Task returned from the Attempt that wrote it is that Attempt's version (#1434).
      latestVersion: 2,
      origin: { kind: "message", id: REPLY },
      actor: { kind: "hob", id: ADA },
    });
  });
});

describe("message authors", () => {
  // covers ADR 037 (Every author is an actor)
  it("names you or the channel's hob as each message's author, read and journaled (#1383)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { yours, reply } = yield* seed;
        const repo = yield* HobbotsRepository;
        return { yours, reply, read: yield* repo.listMessages(CHANNEL) };
      }),
    );
    expect(result.yours.actor).toEqual(OWNER_ACTOR);
    expect(result.reply.actor).toEqual({ kind: "hob", id: ADA });
    expect(result.read.map((each) => each.actor)).toEqual([OWNER_ACTOR, { kind: "hob", id: ADA }]);
  });

  // covers ADR 037 (Every author is an actor), DP-003
  it("gives every stored message and journaled message entry an author when it migrates (#1383)", async () => {
    const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0101")) as typeof migrations;
    const result = await Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();
      yield* sql`INSERT INTO agents ${sql.insert({
        id: ADA,
        name: "Ada",
        runtime: "claude-code",
        role_title: "Guide",
        instructions: "",
        look_seed: 1,
        look_color: "moss",
        created_at: NOW,
      })}`;
      yield* sql`INSERT INTO channels ${sql.insert({ id: CHANNEL, agent_id: ADA, title: "Launch", created_at: NOW, updated_at: NOW })}`;
      yield* sql`INSERT INTO chapters ${sql.insert({ id: "c1", channel_id: CHANNEL, number: 1, state: "live", started_at: NOW })}`;
      for (const [index, [id, role]] of [
        ["ask-1", "user"],
        [REPLY, "assistant"],
      ].entries()) {
        yield* sql`INSERT INTO messages ${sql.insert({
          id,
          channel_id: CHANNEL,
          chapter_id: "c1",
          seq: index + 1,
          role,
          content: id,
          status: "complete",
          created_at: NOW,
        })}`;
        const sequence = index + 1;
        const payload = { _tag: "MessageUpserted", message: { id, channelId: CHANNEL, chapterId: "c1", role } };
        yield* sql`INSERT INTO event_journal ${sql.insert({
          sequence,
          id: `event-${sequence}`,
          type: "MessageUpserted",
          schema_version: 5,
          occurred_at: NOW,
          agent_id: ADA,
          channel_id: CHANNEL,
          payload: JSON.stringify(payload),
        })}`;
        yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
      }
      yield* recordsMigration;
      const rows = yield* sql<{ id: string; actor_kind: string; actor_id: string }>`SELECT id, actor_kind, actor_id
        FROM messages ORDER BY seq`;
      const entries = yield* sql<{ schema_version: unknown; payload: string }>`SELECT schema_version, payload
        FROM event_journal WHERE type = 'MessageUpserted' ORDER BY sequence`;
      const refused = yield* Effect.exit(
        sql`INSERT INTO messages ${sql.insert({
          id: "no-author",
          channel_id: CHANNEL,
          chapter_id: "c1",
          seq: 9,
          role: "user",
          content: "",
          status: "complete",
          created_at: NOW,
        })}`,
      );
      return { rows, entries, refused };
    }).pipe(Effect.provide(TestDatabaseAt(earlier)), Effect.scoped, Effect.runPromise);
    expect(result.rows).toEqual([
      { id: "ask-1", actor_kind: "user", actor_id: "owner" },
      { id: REPLY, actor_kind: "hob", actor_id: ADA },
    ]);
    expect(
      result.entries.map((entry) => [Number(entry.schema_version), JSON.parse(entry.payload).message.actor]),
    ).toEqual([
      [6, OWNER_ACTOR],
      [6, { kind: "hob", id: ADA }],
    ]);
    // The database refuses a message with no author from now on.
    expect(Exit.isFailure(result.refused)).toBe(true);
  });
});
