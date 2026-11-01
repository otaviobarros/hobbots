import { HobbotsRepository, type NewTask, TaskRepository, TaskToolCalls } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type BackpackItem,
  CheckpointId,
  type Committed,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  type EventEnvelope,
  QuestId,
  QuestionId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  BackpackLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  BackpackLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    HobbotsRepository | TaskRepository | TaskToolCalls | Backpack | EventJournal | SqlClient.SqlClient
  >,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-01T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const threadId = ThreadId.make("t1");

let clock = 0;
const newTask = (id: string, ownerId: AgentId, parentId: string | null): NewTask => ({
  id: TaskId.make(id),
  ownerId,
  parentId: parentId === null ? null : TaskId.make(parentId),
  threadId,
  brief: `Brief for ${id}`,
  dependsOn: [],
  createdAt: new Date(Date.parse(now) + 1000 * ++clock).toISOString(),
});

const brief = (id: string) => ({
  id: DelegationId.make(id),
  brief: `Delegated ${id}`,
  expectedOutput: null,
  authority: { overrides: {}, folders: null },
  timeoutMs: null,
});

/** Aldric's campaign as a Quest, with Quill and Ada brought in. */
const campaign = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [ALDRIC, "Aldric"],
    [QUILL, "Quill"],
    [ADA, "Ada"],
  ] as const) {
    yield* repo.insertAgent(
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
        createdAt: now,
      }),
    );
  }
  yield* repo.upsertThread(
    new Thread({ id: threadId, agentId: ALDRIC, title: "Campaign", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  yield* tasks.createTask({ task: newTask("campaign", ALDRIC, null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: TaskId.make("campaign"),
    goal: "A campaign",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  const copy = yield* tasks.createTask({
    task: newTask("copy", QUILL, "campaign"),
    delegation: brief("d-copy"),
    milestones: [],
  });
  const build = yield* tasks.createTask({
    task: newTask("build", ADA, "campaign"),
    delegation: brief("d-build"),
    milestones: [],
  });
  return { copy, build };
});

const tags = (entries: ReadonlyArray<EventEnvelope>) => entries.map((entry) => entry.type);

/** The item a committed change recorded, from its BackpackItemRecorded entry. */
const recorded = (committed: Committed<unknown>): BackpackItem => {
  const entry = committed.entries.find((each) => each.payload._tag === "BackpackItemRecorded");
  if (entry === undefined || entry.payload._tag !== "BackpackItemRecorded") throw new Error("no item recorded");
  return entry.payload.item;
};

const count = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly count: unknown }>`SELECT COUNT(*) AS count FROM backpack_items`;
  return Number(row?.count);
});

describe("A hob's backpack", () => {
  // covers IN-001
  it("[TC-IN-020] records a backpack item in the transaction of the change that causes it, and none when the change is refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { copy } = yield* campaign;
        const tasks = yield* TaskRepository;
        const backpack = yield* Backpack;
        const journal = yield* EventJournal;
        const stored = yield* backpack.find(recorded(copy).id);
        const before = yield* count;
        const headBefore = yield* journal.head;
        // A Task under a hob that does not exist is refused: no Task, no event and no item.
        const refused = yield* tasks
          .createTask({
            task: newTask("ghost", AgentId.make("nobody"), "campaign"),
            delegation: brief("d-x"),
            milestones: [],
          })
          .pipe(Effect.flip);
        const replay = yield* journal.readAfter((copy.entries[0]?.sequence ?? 0) - 1, copy.entries.length);
        return {
          copy,
          stored,
          refused,
          before,
          after: yield* count,
          headBefore,
          headAfter: yield* journal.head,
          replay,
        };
      }),
    );

    // The member's Task and its backpack item commit together, the item's event right after the Task's.
    expect(tags(result.copy.entries)).toEqual(["TaskCreated", "BackpackItemRecorded"]);
    expect(result.replay).toEqual(result.copy.entries);
    expect(result.stored).toMatchObject({
      recipientId: QUILL,
      kind: "task",
      actionable: true,
      priority: 1,
      state: "pending",
      taskId: "copy",
      questId: "q1",
      threadId,
      claim: null,
      fencingToken: 0,
      deliveries: [],
      dedupeKey: `task:copy:v${result.copy.value.revision}:task`,
      payload: { _tag: "task", task: { id: "copy" }, delegation: { id: "d-copy", leadId: ALDRIC } },
    });
    expect(result.stored.revision).toBe(result.copy.entries[1]?.sequence);
    expect(result.copy.entries[1]?.correlation).toEqual({ agentId: QUILL, threadId, messageId: null });
    expect(result.refused).toMatchObject({ _tag: "TaskRefused", reason: "owner-missing" });
    expect(result.after).toBe(result.before);
    expect(result.headAfter).toEqual(result.headBefore);
  });

  // covers IN-001, IN-003
  it("[TC-IN-021] keys an item from a hob tool call by the call's key, so the call retried records no second item", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const ledger = yield* TaskToolCalls;
        const backpack = yield* Backpack;
        const call = {
          agentId: QUILL,
          key: "report-1",
          tool: "report_checkpoint" as const,
          input: '{"kind":"finding"}',
          at: now,
        };
        const report = ledger.once(
          call,
          tasks
            .recordCheckpoint({
              id: CheckpointId.make("c-finding"),
              taskId: TaskId.make("copy"),
              source: "unplanned",
              kind: "finding",
              milestoneId: null,
              summary: "Black Friday copy runs long",
              createdAt: now,
            })
            .pipe(
              Effect.map((committed) => ({
                done: { message: "Reported", details: { checkpointId: committed.value.id } },
                entries: committed.entries,
              })),
            ),
        );
        const first = yield* report;
        const retried = yield* report;
        return { first, retried, open: yield* backpack.listOpen({ _tag: "Hob", agentId: ALDRIC }) };
      }),
    );

    expect(tags(result.first.entries)).toEqual(["CheckpointRecorded", "BackpackItemRecorded"]);
    expect(result.retried.entries).toEqual([]);
    expect(result.open.map((item) => [item.kind, item.dedupeKey])).toEqual([
      ["checkpoint", "tool:quill:report-1:checkpoint:checkpoint:c-finding"],
    ]);
  });

  // covers IN-001, IN-002, IN-005
  it("[TC-IN-022] records each kind for the hob it needs, and keeps routine progress from being actionable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { copy } = yield* campaign;
        const tasks = yield* TaskRepository;
        const started = yield* tasks.startAttempt(copy.value.id, copy.value.revision, {
          id: AttemptId.make("a1"),
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: now,
        });
        const asked = yield* tasks.askQuestion({
          id: QuestionId.make("q-quill"),
          taskId: copy.value.id,
          askerId: QUILL,
          text: "Which market?",
          createdAt: now,
        });
        const answered = yield* tasks.answerQuestion(asked.value.id, { _tag: "Lead", agentId: ALDRIC }, "EU", now);
        const done = yield* tasks.completeTask(copy.value.id, started.value.task.revision, {
          summary: "Copy drafted",
          attemptId: AttemptId.make("a1"),
          artifacts: [],
          at: now,
        });
        return { started, asked, answered, done };
      }),
    );

    expect(recorded(result.started)).toMatchObject({
      recipientId: ALDRIC,
      kind: "progress",
      actionable: false,
      priority: 0,
    });
    expect(recorded(result.asked)).toMatchObject({ recipientId: ALDRIC, kind: "question", actionable: true });
    expect(recorded(result.answered)).toMatchObject({ recipientId: QUILL, kind: "answer", priority: 2 });
    expect(recorded(result.done)).toMatchObject({
      recipientId: ALDRIC,
      kind: "result",
      attemptId: "a1",
      questId: "q1",
      payload: { _tag: "result", task: { id: "copy", state: "completed" } },
    });
    // The hub's own "done" checkpoint is not a second item: the result says it.
    expect(tags(result.done.entries)).toEqual(["TaskCompleted", "CheckpointRecorded", "BackpackItemRecorded"]);
  });

  // covers IN-002
  it("[TC-IN-023] moves an item only through legal steps under its claim, recording each delivery and acknowledgement", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { copy } = yield* campaign;
        const backpack = yield* Backpack;
        const journal = yield* EventJournal;
        const id = recorded(copy).id;
        const claimed = yield* backpack.claim(id, "hub-1:turn-1", "1 minute");
        const held = { owner: "hub-1:turn-1", token: claimed.value.fencingToken };
        const again = yield* backpack.claim(id, "hub-2:turn-9", "1 minute").pipe(Effect.flip);
        const head = yield* journal.head;
        const early = yield* backpack.process(id, held).pipe(Effect.flip);
        const unchanged = yield* journal.head;
        const delivered = yield* backpack.deliver(id, held, { target: "thread:t1", turnId: "m-1" });
        const acknowledged = yield* backpack.acknowledge(id, held, "session-1");
        const processing = yield* backpack.process(id, held);
        const resolved = yield* backpack.resolve(id, held, { _tag: "consumed", by: "m-1" });
        const after = yield* backpack.resolve(id, held, { _tag: "consumed", by: "m-1" }).pipe(Effect.flip);
        const open = yield* backpack.listOpen({ _tag: "Hob", agentId: QUILL });
        return { claimed, again, head, early, unchanged, delivered, acknowledged, processing, resolved, after, open };
      }),
    );

    expect(result.claimed.value).toMatchObject({
      state: "pending",
      fencingToken: 1,
      claim: { owner: "hub-1:turn-1", token: 1 },
    });
    expect(tags(result.claimed.entries)).toEqual(["BackpackItemChanged"]);
    expect(result.again).toMatchObject({ _tag: "BackpackItemUnclaimable", reason: "claimed" });
    // Processing before delivery is refused and writes nothing.
    expect(result.early).toMatchObject({ _tag: "IllegalBackpackTransition", from: "pending", step: "process" });
    expect(result.unchanged).toEqual(result.head);
    expect(result.delivered.value).toMatchObject({
      state: "delivered",
      deliveries: [{ number: 1, target: "thread:t1", turnId: "m-1", acknowledgedSessionId: null }],
    });
    expect(result.acknowledged.value).toMatchObject({
      state: "acknowledged",
      deliveries: [{ number: 1, acknowledgedSessionId: "session-1" }],
    });
    expect(result.processing.value.state).toBe("processing");
    expect(result.resolved.value).toMatchObject({
      state: "resolved",
      claim: null,
      fencingToken: 1,
      disposition: { _tag: "consumed", by: "m-1" },
    });
    expect(result.resolved.value.revision).toBe(result.resolved.entries[0]?.sequence);
    // Once resolved its claim is gone, so nothing more can be written under it.
    expect(result.after).toMatchObject({ _tag: "StaleBackpackClaim" });
    expect(result.open.map((item) => item.taskId)).not.toContain("copy");
  });

  // covers IN-002, IN-003
  it("[TC-IN-024] refuses a write under another owner, an older token or a lapsed lease, and expiring a claim raises its token", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { copy, build } = yield* campaign;
        const backpack = yield* Backpack;
        const id = recorded(copy).id;
        const claimed = yield* backpack.claim(id, "hub-1:turn-1", "1 minute");
        const held = { owner: "hub-1:turn-1", token: claimed.value.fencingToken };
        const otherOwner = yield* backpack
          .deliver(id, { ...held, owner: "hub-2:turn-1" }, { target: "t", turnId: "m" })
          .pipe(Effect.flip);
        const olderToken = yield* backpack
          .deliver(id, { ...held, token: 0 }, { target: "t", turnId: "m" })
          .pipe(Effect.flip);
        yield* backpack.deliver(id, held, { target: "thread:t1", turnId: "m-1" });
        // A lease that ran out is refused at once, before anything expires it.
        yield* backpack.renew(id, held, "1 millis");
        yield* Effect.sleep("30 millis");
        const lapsedWrite = yield* backpack.acknowledge(id, held, "session-1").pipe(Effect.flip);
        const lapsedRenew = yield* backpack.renew(id, held, "1 minute").pipe(Effect.flip);
        // Ada's item has a live claim, so only the lapsed one expires.
        yield* backpack.claim(recorded(build).id, "hub-1:turn-2", "1 minute");
        const expired = yield* backpack.expireClaims();
        const staleAfter = yield* backpack.acknowledge(id, held, "session-1").pipe(Effect.flip);
        const reclaimed = yield* backpack.claim(id, "hub-2:turn-1", "1 minute");
        // At boot every claim is expired, live or not.
        const boot = yield* backpack.expireClaims({ all: true });
        return { otherOwner, olderToken, lapsedWrite, lapsedRenew, expired, staleAfter, reclaimed, boot };
      }),
    );

    expect(result.otherOwner).toMatchObject({ _tag: "StaleBackpackClaim", token: 1 });
    expect(result.olderToken).toMatchObject({ _tag: "StaleBackpackClaim", token: 0 });
    expect(result.lapsedWrite).toMatchObject({ _tag: "StaleBackpackClaim" });
    expect(result.lapsedRenew).toMatchObject({ _tag: "StaleBackpackClaim" });
    // The lapsed claim ends without its owner: its token rises and the delivered item is pending again.
    expect(result.expired.value).toHaveLength(1);
    expect(result.expired.value[0]).toMatchObject({ taskId: "copy", state: "pending", claim: null, fencingToken: 2 });
    expect(tags(result.expired.entries)).toEqual(["BackpackItemChanged"]);
    expect(result.staleAfter).toMatchObject({ _tag: "StaleBackpackClaim" });
    expect(result.reclaimed.value).toMatchObject({ fencingToken: 3, claim: { owner: "hub-2:turn-1", token: 3 } });
    const boot = result.boot.value.map((item) => [item.taskId, item.fencingToken, item.claim]);
    expect(boot.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["build", 2, null],
      ["copy", 4, null],
    ]);
  });

  // covers IN-001
  it("[TC-IN-025] reads a hob's, a Quest's and the workspace's open items, highest priority first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { copy } = yield* campaign;
        const tasks = yield* TaskRepository;
        const backpack = yield* Backpack;
        const asked = yield* tasks.askQuestion({
          id: QuestionId.make("q-quill"),
          taskId: copy.value.id,
          askerId: QUILL,
          text: "Which market?",
          createdAt: now,
        });
        yield* tasks.answerQuestion(asked.value.id, { _tag: "Lead", agentId: ALDRIC }, "EU", now);
        // Aldric's own Task, outside any Quest, records nothing.
        yield* tasks.createTask({ task: newTask("other", ALDRIC, null), delegation: null, milestones: [] });
        return {
          quill: yield* backpack.listOpen({ _tag: "Hob", agentId: QUILL }),
          aldric: yield* backpack.listOpen({ _tag: "Hob", agentId: ALDRIC }),
          quest: yield* backpack.listOpen({ _tag: "Quest", questId: QuestId.make("q1") }),
          none: yield* backpack.listOpen({ _tag: "Quest", questId: QuestId.make("q-none") }),
          workspace: yield* backpack.listOpen({ _tag: "Workspace" }),
          missing: yield* backpack.find("nothing" as BackpackItem["id"]).pipe(Effect.flip),
        };
      }),
    );

    // The answer unblocks Quill, so it comes before Quill's Task.
    expect(result.quill.map((item) => item.kind)).toEqual(["answer", "task"]);
    expect(result.aldric.map((item) => item.kind)).toEqual(["question"]);
    expect(result.quest.map((item) => [item.recipientId, item.kind])).toEqual([
      [QUILL, "answer"],
      [QUILL, "task"],
      [ADA, "task"],
      [ALDRIC, "question"],
    ]);
    expect(result.none).toEqual([]);
    expect(result.workspace).toHaveLength(4);
    expect(result.workspace[0]?.kind).toBe("answer");
    expect(result.missing).toMatchObject({ _tag: "BackpackItemMissing" });
  });
});
