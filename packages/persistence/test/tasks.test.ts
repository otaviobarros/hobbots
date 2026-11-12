import {
  ApprovalRepository,
  HobbotsRepository,
  type NewAttempt,
  type NewTask,
  TaskRepository,
  TaskToolCalls,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  ArtifactId,
  AttemptId,
  CheckpointId,
  type Committed,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  type EventEnvelope,
  MilestoneId,
  NoteId,
  partyOf,
  QuestId,
  QuestionId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  ApprovalRepositoryLive,
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
  ApprovalRepositoryLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    HobbotsRepository | TaskRepository | TaskToolCalls | ApprovalRepository | EventJournal | SqlClient.SqlClient
  >,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

/** What the Task's ledger holds in its owner's backpack, as a turn that was shown all of it carries it. */
const carryAll = (id: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    return carriedFrom(Option.getOrThrow(yield* tasks.readLedger(TaskId.make(id))), () => true);
  });

/** The Task as it is stored now. */
const latest = (id: string) =>
  TaskRepository.use((tasks) => tasks.readTree(TaskId.make(id))).pipe(
    Effect.map((tree) => {
      const task = Option.getOrThrow(tree).tasks[0];
      if (task === undefined) throw new Error(`no Task ${id}`);
      return task;
    }),
  );

const now = "2026-11-01T00:00:00.000Z";
const later = "2026-11-01T01:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("t1");

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  for (const [id, name] of [
    [ALDRIC, "Aldric"],
    [QUILL, "Quill"],
    [ADA, "Ada"],
    [PIP, "Pip"],
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
});

// Each new Task is a second younger than the last, so oldest first is the order they were created in.
let clock = 0;
const newTask = (
  id: string,
  ownerId: AgentId,
  parentId: string | null,
  dependsOn: ReadonlyArray<string> = [],
): NewTask => ({
  id: TaskId.make(id),
  ownerId,
  parentId: parentId === null ? null : TaskId.make(parentId),
  threadId,
  brief: `Brief for ${id}`,
  dependsOn: dependsOn.map((each) => TaskId.make(each)),
  createdAt: new Date(Date.parse(now) + 1000 * ++clock).toISOString(),
});

const brief = (id: string) => ({
  id: DelegationId.make(id),
  brief: `Delegated ${id}`,
  expectedOutput: null,
  authority: { overrides: { push: "deny" as const }, folders: null },
  timeoutMs: null,
});

const attempt = (id: string): NewAttempt => ({
  id: AttemptId.make(id),
  runtime: "claude-code",
  sessionId: null,
  configVersion: 1,
  policyVersion: "r3-0123456789abcdef",
  startedAt: now,
});

/** Aldric's campaign: a Quest with Quill drafting copy and Ada building the campaign once it exists. */
const campaign = Effect.gen(function* () {
  yield* seed;
  const tasks = yield* TaskRepository;
  yield* tasks.createTask({ task: newTask("campaign", ALDRIC, null), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: TaskId.make("campaign"),
    goal: "A Black Friday campaign",
    acceptance: ["Copy approved", "Campaign built"],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  yield* tasks.createTask({
    task: newTask("copy", QUILL, "campaign"),
    delegation: brief("d-copy"),
    milestones: [{ id: MilestoneId.make("m-draft"), title: "First draft" }],
  });
  yield* tasks.createTask({
    task: newTask("build", ADA, "campaign", ["copy"]),
    delegation: brief("d-build"),
    milestones: [],
  });
});

/** The journal entries a write appended, as stored: the same as the write returned. */
const journaled = <A>(committed: Committed<A>) =>
  Effect.gen(function* () {
    const journal = yield* EventJournal;
    const first = committed.entries[0]?.sequence ?? 0;
    const stored = yield* journal.readAfter(first - 1, committed.entries.length);
    return { stored, returned: committed.entries };
  });

const tags = (entries: ReadonlyArray<EventEnvelope>) => entries.map((entry) => entry.type);

describe("Task records", () => {
  // covers OR-002, EX-001
  it("[TC-OR-001] keeps each Task's owner, parent and root, adds a Quest to the same Task, and nests a member's Quest one deeper", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const step = yield* tasks.createTask({
          task: newTask("research", ADA, "build"),
          delegation: null,
          milestones: [],
        });
        const nested = yield* tasks.startQuest({
          id: QuestId.make("q2"),
          taskId: TaskId.make("build"),
          goal: "Keywords",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        yield* tasks.createTask({
          task: newTask("keywords", PIP, "build"),
          delegation: brief("d-keywords"),
          milestones: [],
        });
        const tree = yield* tasks.readTree(TaskId.make("campaign"));
        const sub = yield* tasks.readTree(TaskId.make("build"));
        return { step, nested, tree: Option.getOrThrow(tree), sub: Option.getOrThrow(sub) };
      }),
    );

    expect(result.tree.tasks.map((task) => [task.id, task.ownerId, task.parentId, task.rootId, task.threadId])).toEqual(
      [
        ["campaign", ALDRIC, null, "campaign", threadId],
        ["copy", QUILL, "campaign", "campaign", threadId],
        ["build", ADA, "campaign", "campaign", threadId],
        ["research", ADA, "build", "campaign", threadId],
        ["keywords", PIP, "build", "campaign", threadId],
      ],
    );
    expect(result.tree.tasks.find((task) => task.id === "build")?.dependsOn).toEqual(["copy"]);
    expect(
      result.tree.quests.map((quest) => [quest.id, quest.taskId, quest.leadId, quest.parentQuestId, quest.depth]),
    ).toEqual([
      ["q1", "campaign", ALDRIC, null, 1],
      ["q2", "build", ADA, "q1", 2],
    ]);
    // A step has its parent's owner and no Delegation; a member's Task has one, from its lead.
    expect(
      result.tree.delegations.map((d) => [d.id, d.questId, d.leadId, d.memberId, d.parentTaskId, d.childTaskId]),
    ).toEqual([
      ["d-copy", "q1", ALDRIC, QUILL, "campaign", "copy"],
      ["d-build", "q1", ALDRIC, ADA, "campaign", "build"],
      ["d-keywords", "q2", ADA, PIP, "build", "keywords"],
    ]);
    expect(result.tree.delegations[0]?.authority).toEqual({ overrides: { push: "deny" }, folders: null });
    expect(result.tree.milestones.map((m) => [m.id, m.taskId, m.position, m.reachedAt])).toEqual([
      ["m-draft", "copy", 0, null],
    ]);
    const [q1, q2] = result.tree.quests;
    expect(q1 && partyOf(q1, result.tree.delegations)).toEqual([QUILL, ADA]);
    expect(q2 && partyOf(q2, result.tree.delegations)).toEqual([PIP]);
    // A subtree holds only what is under its Task.
    expect(result.sub.tasks.map((task) => task.id)).toEqual(["build", "research", "keywords"]);
    expect(result.sub.quests.map((quest) => quest.id)).toEqual(["q2"]);
    // Each change is journaled with its event, correlated with the Task's owner and thread. A new
    // step also lands in its owner's backpack, journaled after it (ADR 019).
    // The step is a Task under the Quest, so the Quest's summary changes in the same transaction (ADR 037).
    expect(tags(result.step.entries)).toEqual(["TaskCreated", "BackpackItemRecorded", "QuestSummaryChanged"]);
    expect(result.step.entries[0]?.correlation).toEqual({ agentId: ADA, threadId, messageId: null });
    expect(result.step.value.revision).toBe(result.step.entries[0]?.sequence);
    // A new Quest's summary is journaled with it; the Quest it sits in still counts the same Tasks.
    expect(tags(result.nested.entries)).toEqual(["QuestStarted", "QuestSummaryChanged"]);
    expect(result.nested.entries[0]?.correlation).toEqual({ agentId: ADA, threadId, messageId: null });
  });

  // covers OR-002, EX-002
  it("[TC-OR-002] refuses a Task without an owner, an orphan, a step under another owner, and a dependency outside its tree, writing nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const journal = yield* EventJournal;
        const sql = yield* SqlClient.SqlClient;
        const refused = (input: Parameters<typeof tasks.createTask>[0]) =>
          tasks.createTask(input).pipe(
            Effect.flip,
            Effect.map((error) => (error._tag === "TaskRefused" ? error.reason : error._tag)),
          );
        yield* tasks.createTask({ task: newTask("other", PIP, null), delegation: null, milestones: [] });
        const head = yield* journal.head;
        const reasons = [
          yield* refused({ task: newTask("x1", AgentId.make("nobody"), null), delegation: null, milestones: [] }),
          yield* refused({ task: newTask("x2", ALDRIC, "missing"), delegation: null, milestones: [] }),
          yield* refused({ task: newTask("x3", PIP, "campaign"), delegation: null, milestones: [] }),
          yield* refused({ task: newTask("x4", ALDRIC, "campaign"), delegation: brief("d-x4"), milestones: [] }),
          yield* refused({ task: newTask("x5", ALDRIC, "other"), delegation: null, milestones: [] }),
          yield* refused({ task: newTask("x6", ALDRIC, "other"), delegation: brief("d-x6"), milestones: [] }),
          yield* refused({ task: newTask("x7", ADA, "build", ["other"]), delegation: null, milestones: [] }),
          yield* refused({ task: newTask("x8", ALDRIC, null), delegation: brief("d-x8"), milestones: [] }),
        ];
        const stored = yield* sql<{ readonly id: string }>`SELECT id FROM tasks ORDER BY id`;
        return { head, after: yield* journal.head, reasons, stored: stored.map((row) => row.id) };
      }),
    );

    expect(result.reasons).toEqual([
      "owner-missing",
      "parent-missing",
      "step-owner",
      "delegation-mismatch",
      "step-owner",
      "quest-missing",
      "dependency-outside-tree",
      "delegation-mismatch",
    ]);
    // Every refused Task left no row and no journal entry.
    expect(result.stored).toEqual(["build", "campaign", "copy", "other"]);
    expect(result.after).toEqual(result.head);
  });

  // covers EX-001, EX-002
  it("[TC-EX-016] adds an Attempt for each retry, refuses a stale or illegal change without writing, and journals each change in its transaction", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const journal = yield* EventJournal;
        const copy = TaskId.make("copy");
        const created = Option.getOrThrow(yield* tasks.readTree(copy)).tasks[0];
        if (created === undefined) throw new Error("no Task");
        const first = yield* tasks.startAttempt(copy, created.revision, attempt("a1"));
        const twice = yield* tasks.startAttempt(copy, first.value.task.revision, attempt("a-twice")).pipe(Effect.flip);
        const running = yield* tasks.updateAttempt(AttemptId.make("a1"), { _tag: "Running", sessionId: "s1", at: now });
        const stale = yield* tasks.moveTask(copy, created.revision, "waiting", now).pipe(Effect.flip);
        const failed = yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "Timed out" },
          at: now,
        });
        const moved = yield* tasks.moveTask(copy, failed.value.task.revision, "failed", now);
        const head = yield* journal.head;
        const illegal = yield* tasks.moveTask(copy, moved.value.revision, "waiting", now).pipe(Effect.flip);
        const unchanged = yield* journal.head;
        const retry = yield* tasks.startAttempt(copy, moved.value.revision, attempt("a2"));
        const tree = Option.getOrThrow(yield* tasks.readTree(copy));
        return {
          first,
          twice,
          running,
          stale,
          moved,
          head,
          illegal,
          unchanged,
          retry,
          tree,
          journal: yield* journaled(retry),
        };
      }),
    );

    // The hub's started checkpoint reaches Quill's lead as routine progress (ADR 019).
    expect(tags(result.first.entries)).toEqual([
      "TaskStateChanged",
      "CheckpointRecorded",
      "BackpackItemRecorded",
      "QuestSummaryChanged",
    ]);
    expect(result.first.value.task).toMatchObject({ state: "active", currentAttemptId: "a1" });
    expect(result.twice).toMatchObject({ _tag: "TaskRefused", reason: "attempt-live" });
    expect(result.running.value.attempt).toMatchObject({ state: "running", sessionId: "s1" });
    expect(result.stale).toMatchObject({ _tag: "StaleTask", taskId: "copy" });
    // Quill's failure lands in its lead's backpack (ADR 019).
    expect(tags(result.moved.entries)).toEqual([
      "TaskStateChanged",
      "CheckpointRecorded",
      "BackpackItemRecorded",
      "QuestSummaryChanged",
    ]);
    expect(result.illegal).toMatchObject({ _tag: "IllegalTaskTransition", from: "failed", to: "waiting" });
    expect(result.unchanged).toEqual(result.head);
    // The retry is the same Task with a second Attempt; the first keeps its outcome.
    expect(result.retry.value.task).toMatchObject({ id: "copy", state: "active", currentAttemptId: "a2" });
    expect(result.tree.tasks.map((task) => task.id)).toEqual(["copy"]);
    expect(result.tree.attempts.map((a) => [a.id, a.number, a.agentId, a.state, a.outcome])).toEqual([
      ["a1", 1, QUILL, "failed", "Timed out"],
      ["a2", 2, QUILL, "starting", null],
    ]);
    expect(result.tree.checkpoints.map((c) => [c.source, c.kind, c.attemptId])).toEqual([
      ["automatic", "started", "a1"],
      ["automatic", "failed", "a1"],
      ["automatic", "started", "a2"],
    ]);
    expect(result.journal.stored).toEqual(result.journal.returned);
  });

  // covers OR-006, IN-007
  it("[TC-OR-560] lists a member's failed Task with the lead you talk to while its work goes on, until it is retried or the work ends", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = TaskId.make("copy");
        const started = yield* tasks.startAttempt(copy, (yield* latest("copy")).revision, attempt("a1"));
        yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "Timed out" },
          at: now,
        });
        yield* tasks.moveTask(copy, (yield* latest("copy")).revision, "failed", now);
        const build = yield* latest("build");
        yield* tasks.moveTask(build.id, build.revision, "failed", later);
        const failed = yield* tasks.listFailedTasks;
        yield* tasks.startAttempt(copy, (yield* latest("copy")).revision, attempt("a2"));
        const retried = yield* tasks.listFailedTasks;
        yield* tasks.updateAttempt(AttemptId.make("a2"), {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "Timed out again" },
          at: later,
        });
        yield* tasks.moveTask(copy, (yield* latest("copy")).revision, "failed", later);
        const campaignTask = yield* latest("campaign");
        yield* tasks.moveTask(campaignTask.id, campaignTask.revision, "failed", later);
        const ended = yield* tasks.listFailedTasks;
        return { started: started.value.task.state, failed, retried, ended };
      }),
    );

    expect(result.started).toBe("active");
    expect(result.failed.map(({ task, leadId }) => [task.id, task.ownerId, leadId])).toEqual([
      ["copy", QUILL, ALDRIC],
      ["build", ADA, ALDRIC],
    ]);
    expect(result.retried.map(({ task }) => task.id)).toEqual(["build"]);
    expect(result.ended).toEqual([]);
  });

  // covers EX-001, OR-006
  it("[TC-OR-004] completes a Task only with its own Attempt and a settled ledger, and its Quest with it", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const campaignId = TaskId.make("campaign");
        const finish = (id: string, attemptId: string, at: string) =>
          Effect.gen(function* () {
            const task = Option.getOrThrow(yield* tasks.readTree(TaskId.make(id))).tasks[0];
            if (task === undefined) throw new Error("no Task");
            const started = yield* tasks.startAttempt(task.id, task.revision, attempt(attemptId));
            // A promised milestone is reached before the Task can complete.
            for (const milestone of Option.getOrThrow(yield* tasks.readTree(task.id)).milestones) {
              yield* tasks.recordCheckpoint({
                id: CheckpointId.make(`reached-${milestone.id}`),
                taskId: task.id,
                source: "planned",
                kind: "milestone",
                milestoneId: milestone.id,
                summary: milestone.title,
                createdAt: at,
              });
            }
            return yield* tasks.completeTask(task.id, started.value.task.revision, {
              summary: `${id} done`,
              attemptId: AttemptId.make(attemptId),
              artifacts: [{ id: ArtifactId.make(`art-${id}`), kind: "text", label: id, value: `${id} text` }],
              at,
              carried: yield* carryAll(id),
            });
          });
        const root = Option.getOrThrow(yield* tasks.readTree(campaignId)).tasks[0];
        if (root === undefined) throw new Error("no Task");
        const started = yield* tasks.startAttempt(campaignId, root.revision, attempt("a-root"));
        const revision = started.value.task.revision;
        const completion = (attemptId: string) => ({
          summary: "Campaign ready",
          attemptId: AttemptId.make(attemptId),
          artifacts: [],
          at: later,
        });
        const otherAttempt = yield* tasks.completeTask(campaignId, revision, completion("a1")).pipe(Effect.flip);
        const childrenOpen = yield* tasks.completeTask(campaignId, revision, completion("a-root")).pipe(Effect.flip);
        yield* finish("copy", "a1", "2026-11-01T00:30:00.000Z");
        const question = yield* tasks.askQuestion({
          id: QuestionId.make("q-build"),
          taskId: TaskId.make("build"),
          askerId: ADA,
          text: "Which tone?",
          createdAt: now,
        });
        const ask = yield* tasks.answerQuestion(question.value.id, { _tag: "Lead", agentId: ALDRIC }, "Playful", now);
        yield* finish("build", "a2", "2026-11-01T00:40:00.000Z");
        yield* tasks.askQuestion({
          id: QuestionId.make("q-root"),
          taskId: campaignId,
          askerId: ALDRIC,
          text: "Ship on Friday?",
          createdAt: now,
        });
        const current = Option.getOrThrow(yield* tasks.readTree(campaignId)).tasks[0];
        if (current === undefined) throw new Error("no Task");
        const questionsOpen = yield* tasks
          .completeTask(campaignId, current.revision, completion("a-root"))
          .pipe(Effect.flip);
        yield* tasks.answerQuestion(QuestionId.make("q-root"), { _tag: "User" }, "Yes", now);
        // The members' results are still unread in Aldric's backpack until his turn carries them.
        const unread = yield* tasks.completeTask(campaignId, current.revision, completion("a-root")).pipe(Effect.flip);
        const done = yield* tasks.completeTask(campaignId, current.revision, {
          ...completion("a-root"),
          carried: yield* carryAll("campaign"),
        });
        return {
          otherAttempt,
          childrenOpen,
          ask,
          questionsOpen,
          unread,
          done,
          tree: Option.getOrThrow(yield* tasks.readTree(campaignId)),
        };
      }),
    );

    expect(result.otherAttempt).toMatchObject({ _tag: "TaskRefused", reason: "attempt-mismatch" });
    expect(result.childrenOpen).toMatchObject({ _tag: "TaskRefused", reason: "children-open" });
    expect(result.questionsOpen).toMatchObject({ _tag: "TaskRefused", reason: "questions-open" });
    expect(result.ask.value).toMatchObject({
      state: "answered",
      answer: "Playful",
      answeredBy: { _tag: "Lead", agentId: ALDRIC },
    });
    expect(result.unread).toMatchObject({ _tag: "TaskRefused", reason: "items-open" });
    // The completion consumes what it carried, and retires what no longer counts, in its own transaction.
    expect(tags(result.done.entries).slice(0, 3)).toEqual(["TaskCompleted", "CheckpointRecorded", "QuestCompleted"]);
    expect(
      result.done.entries
        .slice(3)
        .map(({ payload }) =>
          payload._tag === "BackpackItemChanged"
            ? [payload.item.kind, payload.item.taskId, payload.item.disposition?._tag]
            : null,
        ),
    ).toEqual([
      ["answer", "campaign", "consumed"],
      ["result", "copy", "consumed"],
      ["result", "build", "consumed"],
      // Copy's milestone report has nothing left to act on once copy ended: it resolves as late.
      ["checkpoint", "copy", "late"],
      // So has the routine progress no turn of Aldric's carried: its Tasks ended (#397).
      ["progress", "copy", "late"],
      ["progress", "build", "late"],
      // Then the Quest's summary, now ended (ADR 037).
      null,
    ]);
    expect(tags(result.done.entries).at(-1)).toBe("QuestSummaryChanged");
    expect(result.done.value).toMatchObject({
      state: "completed",
      result: { summary: "Campaign ready", attemptId: "a-root" },
    });
    expect(result.tree.quests[0]).toMatchObject({ id: "q1", state: "completed", endedAt: later });
    expect(result.tree.quests[0]?.revision).toBe(result.done.entries[2]?.sequence);
    // Each artifact names the Task and Attempt that made it.
    expect(result.tree.artifacts.map((a) => [a.id, a.taskId, a.attemptId])).toEqual([
      ["art-copy", "copy", "a1"],
      ["art-build", "build", "a2"],
    ]);
  });

  // covers OR-003
  it("[TC-OR-003] sends a question to the nearest lead, climbs one lead at a time to the user, and lets only its recipient answer", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        yield* tasks.startQuest({
          id: QuestId.make("q2"),
          taskId: TaskId.make("build"),
          goal: "Keywords",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        yield* tasks.createTask({ task: newTask("keywords", PIP, "build"), delegation: brief("d-k"), milestones: [] });
        yield* tasks.createTask({ task: newTask("keyword-step", PIP, "keywords"), delegation: null, milestones: [] });
        const notAsker = yield* tasks
          .askQuestion({
            id: QuestionId.make("x"),
            taskId: TaskId.make("keywords"),
            askerId: ADA,
            text: "?",
            createdAt: now,
          })
          .pipe(Effect.flip);
        const asked = yield* tasks.askQuestion({
          id: QuestionId.make("q-pip"),
          taskId: TaskId.make("keyword-step"),
          askerId: PIP,
          text: "Which market?",
          createdAt: now,
        });
        const wrong = yield* tasks
          .answerQuestion(asked.value.id, { _tag: "Lead", agentId: ALDRIC }, "EU", now)
          .pipe(Effect.flip);
        const up = yield* tasks.escalateQuestion(asked.value.id, ADA);
        const top = yield* tasks.escalateQuestion(asked.value.id, ALDRIC);
        const byLead = yield* tasks
          .answerQuestion(asked.value.id, { _tag: "Lead", agentId: ALDRIC }, "EU", now)
          .pipe(Effect.flip);
        const answered = yield* tasks.answerQuestion(asked.value.id, { _tag: "User" }, "EU", later);
        const again = yield* tasks.answerQuestion(asked.value.id, { _tag: "User" }, "US", later).pipe(Effect.flip);
        const topAsk = yield* tasks.askQuestion({
          id: QuestionId.make("q-aldric"),
          taskId: TaskId.make("campaign"),
          askerId: ALDRIC,
          text: "Budget?",
          createdAt: now,
        });
        return { notAsker, asked, wrong, up, top, byLead, answered, again, topAsk };
      }),
    );

    expect(result.notAsker).toMatchObject({ _tag: "TaskRefused", reason: "not-asker" });
    // Pip's step asks: its own Task is Pip's, so the nearest lead is Ada, then Aldric, then you.
    expect(result.asked.value).toMatchObject({ recipientId: ADA, chain: [], state: "open" });
    // Each step of the question lands in the backpack of the hob it reaches (ADR 019).
    expect(tags(result.asked.entries)).toEqual(["QuestionAsked", "BackpackItemRecorded"]);
    expect(result.asked.entries[0]?.correlation).toEqual({ agentId: PIP, threadId, messageId: null });
    expect(result.wrong).toMatchObject({ _tag: "TaskRefused", reason: "not-recipient" });
    expect(result.up.value).toMatchObject({ recipientId: ALDRIC, chain: [ADA] });
    // Ada's copy settles as she passes it on (#573), and the question lands in Aldric's backpack.
    expect(tags(result.up.entries)).toEqual(["QuestionEscalated", "BackpackItemChanged", "BackpackItemRecorded"]);
    expect(result.top.value).toMatchObject({ recipientId: null, chain: [ADA, ALDRIC] });
    expect(result.byLead).toMatchObject({ _tag: "TaskRefused", reason: "not-recipient" });
    expect(result.answered.value).toMatchObject({ state: "answered", answer: "EU", answeredBy: { _tag: "User" } });
    // Your answer leaves nothing waiting on you: the summary of each Quest above the Task changes.
    expect(tags(result.answered.entries)).toEqual([
      "QuestionAnswered",
      "BackpackItemRecorded",
      "QuestSummaryChanged",
      "QuestSummaryChanged",
    ]);
    expect(result.again).toMatchObject({ _tag: "TaskRefused", reason: "question-answered" });
    // The lead of the top Task has no lead above it: its question comes straight to you.
    expect(result.topAsk.value.recipientId).toBeNull();
  });

  // covers OR-003, DP-003
  it("[TC-DP-253] keeps a question's choices and whether its answer picked one or was written in words (#740)", async () => {
    const options = [
      { label: "Light", consequence: "Matches the brand guide." },
      { label: "Dark", consequence: "Stands out more." },
    ];
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const ask = (id: string) =>
          tasks.askQuestion({
            id: QuestionId.make(id),
            taskId: TaskId.make("build"),
            askerId: ADA,
            text: "Which theme?",
            createdAt: now,
            options,
            recommended: 0,
          });
        const asked = yield* ask("q-picked");
        yield* ask("q-typed");
        yield* tasks.askQuestion({
          id: QuestionId.make("q-plain"),
          taskId: TaskId.make("build"),
          askerId: ADA,
          text: "Any tagline?",
          createdAt: now,
        });
        // A lead that answers with a choice's label, in any case, picks that choice.
        yield* tasks.answerQuestion(QuestionId.make("q-picked"), { _tag: "Lead", agentId: ALDRIC }, " dark ", now);
        yield* tasks.escalateQuestion(QuestionId.make("q-typed"), ALDRIC);
        yield* tasks.answerQuestion(QuestionId.make("q-typed"), { _tag: "User" }, "Light, with a dark hero", later);
        yield* tasks.answerQuestion(QuestionId.make("q-plain"), { _tag: "Lead", agentId: ALDRIC }, "Light", now);
        // Two choices that read the same could not be told apart by their label, so the hub refuses them.
        const colliding = yield* tasks
          .askQuestion({
            id: QuestionId.make("q-same"),
            taskId: TaskId.make("build"),
            askerId: ADA,
            text: "Which theme?",
            createdAt: now,
            options: [options[0], { label: "LIGHT", consequence: "Brighter still." }].filter(
              (each) => each !== undefined,
            ),
          })
          .pipe(Effect.flip);
        const tree = Option.getOrThrow(yield* tasks.readTree(TaskId.make("campaign")));
        return { asked, colliding, questions: tree.questions };
      }),
    );

    expect(result.asked.value).toMatchObject({ options, recommended: 0, picked: null });
    expect(result.colliding).toMatchObject({ _tag: "TaskRefused", reason: "options-collide" });
    expect(
      result.questions
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map(({ id, options: offered, recommended, picked, answer }) => ({
          id,
          offered: offered.length,
          recommended,
          picked,
          answer,
        })),
    ).toEqual([
      { id: "q-picked", offered: 2, recommended: 0, picked: 1, answer: "Dark" },
      { id: "q-plain", offered: 0, recommended: null, picked: null, answer: "Light" },
      { id: "q-typed", offered: 2, recommended: 0, picked: null, answer: "Light, with a dark hero" },
    ]);
    expect(result.questions.find((each) => each.id === "q-picked")?.options).toEqual(options);
  });

  // covers OR-002, OR-004
  it("[TC-OR-135] gives your note to the Task's nearest lead once, keeps it on the tree, and lists only the questions that wait for you", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        yield* tasks.startQuest({
          id: QuestId.make("q2"),
          taskId: TaskId.make("build"),
          goal: "Keywords",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        yield* tasks.createTask({ task: newTask("keywords", PIP, "build"), delegation: brief("d-k"), milestones: [] });
        yield* tasks.createTask({ task: newTask("keyword-step", PIP, "keywords"), delegation: null, milestones: [] });
        const note = (id: string, taskId: string, text = "Keep it short") =>
          tasks.leaveNote({ id: NoteId.make(id), taskId: TaskId.make(taskId), text, createdAt: now });
        const onStep = yield* note("n-step", "keyword-step");
        const onBuild = yield* note("n-build", "build");
        const onTop = yield* note("n-top", "campaign");
        const again = yield* note("n-step", "keyword-step");
        const reused = yield* note("n-step", "keyword-step", "Make it long").pipe(Effect.flip);
        const missing = yield* note("n-none", "nope").pipe(Effect.flip);
        const tree = Option.getOrThrow(yield* tasks.readTree(TaskId.make("campaign")));

        for (const [id, asker, taskId] of [
          ["q-open", PIP, "keywords"],
          ["q-yours", PIP, "keywords"],
          ["q-done", PIP, "keywords"],
        ] as const) {
          yield* tasks.askQuestion({
            id: QuestionId.make(id),
            taskId: TaskId.make(taskId),
            askerId: asker,
            text: id,
            createdAt: now,
          });
        }
        for (const id of ["q-yours", "q-done"]) {
          yield* tasks.escalateQuestion(QuestionId.make(id), ADA);
          yield* tasks.escalateQuestion(QuestionId.make(id), ALDRIC);
        }
        yield* tasks.answerQuestion(QuestionId.make("q-done"), { _tag: "User" }, "Yes", later);
        const waiting = yield* tasks.listWaitingQuestions;
        return { onStep, onBuild, onTop, again, reused, missing, tree, waiting };
      }),
    );

    // You talk only to the lead: Pip's step goes to Ada, who leads Pip; Ada's Task to Aldric; the top to Aldric.
    expect(result.onStep.value.recipientId).toBe(ADA);
    expect(tags(result.onStep.entries)).toEqual(["NoteLeft", "BackpackItemRecorded"]);
    expect(result.onStep.entries[0]?.correlation).toEqual({ agentId: ADA, threadId, messageId: null });
    expect(result.onStep.entries[1]?.payload).toMatchObject({
      item: { recipientId: ADA, kind: "message", taskId: "keyword-step", payload: { senderId: null } },
    });
    expect(result.onBuild.value.recipientId).toBe(ALDRIC);
    expect(result.onTop.value.recipientId).toBe(ALDRIC);
    // The same note sent again is the first one, and writes nothing.
    expect(result.again.value).toEqual(result.onStep.value);
    expect(result.again.entries).toEqual([]);
    expect(result.reused).toMatchObject({ _tag: "TaskRefused", reason: "note-key-reused" });
    expect(result.missing).toMatchObject({ _tag: "TaskRefused", reason: "task-missing" });
    expect(result.tree.notes.map((each) => each.id)).toEqual(["n-step", "n-build", "n-top"]);
    // Only what climbed every lead and is still open waits for you, with its Task.
    expect(result.waiting.map(({ question, task }) => [question.id, task.id])).toEqual([["q-yours", "keywords"]]);
  });

  // covers OR-004
  it("[TC-OR-136] refuses a note once the work it is about has ended, and takes one on a member's ended Task while it goes on", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const note = (id: string, taskId: string) =>
          tasks.leaveNote({ id: NoteId.make(id), taskId: TaskId.make(taskId), text: "Hi", createdAt: now });
        const copy = Option.getOrThrow(yield* tasks.readTree(TaskId.make("copy"))).tasks[0];
        if (copy === undefined) throw new Error("no copy Task");
        yield* tasks.moveTask(copy.id, copy.revision, "cancelled", now);
        const onEnded = yield* note("n-copy", "copy");
        const build = Option.getOrThrow(yield* tasks.readTree(TaskId.make("build"))).tasks[0];
        if (build === undefined) throw new Error("no build Task");
        yield* tasks.moveTask(build.id, build.revision, "cancelled", now);
        const top = Option.getOrThrow(yield* tasks.readTree(TaskId.make("campaign"))).tasks[0];
        if (top === undefined) throw new Error("no top Task");
        yield* tasks.moveTask(top.id, top.revision, "cancelled", now);
        const afterTop = yield* note("n-late", "copy").pipe(Effect.flip);
        return { onEnded, afterTop };
      }),
    );
    expect(result.onEnded.value.recipientId).toBe(ALDRIC);
    expect(result.afterTop).toMatchObject({ _tag: "TaskRefused", reason: "task-ended" });
  });

  // covers OR-002, OR-004
  it("[TC-OR-137] passes a note over a lead whose Task ended, and drops a question about ended work from what waits for you", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        yield* tasks.startQuest({
          id: QuestId.make("q2"),
          taskId: TaskId.make("build"),
          goal: "Keywords",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        yield* tasks.createTask({ task: newTask("keywords", PIP, "build"), delegation: brief("d-k"), milestones: [] });
        yield* tasks.askQuestion({
          id: QuestionId.make("q-late"),
          taskId: TaskId.make("keywords"),
          askerId: PIP,
          text: "Which market?",
          createdAt: now,
        });
        yield* tasks.escalateQuestion(QuestionId.make("q-late"), ADA);
        yield* tasks.escalateQuestion(QuestionId.make("q-late"), ALDRIC);
        const before = yield* tasks.listWaitingQuestions;
        for (const id of ["keywords", "build"]) {
          const task = Option.getOrThrow(yield* tasks.readTree(TaskId.make(id))).tasks[0];
          if (task === undefined) throw new Error(`no ${id} Task`);
          yield* tasks.moveTask(task.id, task.revision, "cancelled", now);
        }
        const note = yield* tasks.leaveNote({
          id: NoteId.make("n-pip"),
          taskId: TaskId.make("keywords"),
          text: "Hi",
          createdAt: now,
        });
        const after = yield* tasks.listWaitingQuestions;
        const answer = yield* tasks
          .answerQuestion(QuestionId.make("q-late"), { _tag: "User" }, "EU", later)
          .pipe(Effect.flip);
        return { before, note, after, answer };
      }),
    );
    expect(result.before.map(({ question }) => question.id)).toEqual(["q-late"]);
    // Ada's build ended, so she would never read it: the note goes up to Aldric, still at work.
    expect(result.note.value.recipientId).toBe(ALDRIC);
    expect(result.after).toEqual([]);
    expect(result.answer).toMatchObject({ _tag: "TaskRefused", reason: "task-ended" });
  });

  // covers OR-004, OR-006, IN-006
  it("[TC-OR-167] withdraws a question that waits for you when its Task is cancelled, so the lead can still complete", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        yield* tasks.askQuestion({
          id: QuestionId.make("q-cutoff"),
          taskId: TaskId.make("build"),
          askerId: ADA,
          text: "Which cutoff date?",
          createdAt: now,
        });
        yield* tasks.escalateQuestion(QuestionId.make("q-cutoff"), ALDRIC);
        const before = yield* tasks.listWaitingQuestions;
        const build = yield* latest("build");
        const cancelled = yield* tasks.moveTask(build.id, build.revision, "cancelled", later);
        const tree = Option.getOrThrow(yield* tasks.readTree(TaskId.make("campaign")));
        const after = yield* tasks.listWaitingQuestions;
        const answer = yield* tasks
          .answerQuestion(QuestionId.make("q-cutoff"), { _tag: "User" }, "Friday", later)
          .pipe(Effect.flip);
        const copy = yield* latest("copy");
        yield* tasks.moveTask(copy.id, copy.revision, "cancelled", later);
        const top = yield* latest("campaign");
        const started = yield* tasks.startAttempt(top.id, top.revision, attempt("a-top"));
        const done = yield* tasks.completeTask(top.id, started.value.task.revision, {
          summary: "Called off",
          attemptId: AttemptId.make("a-top"),
          artifacts: [],
          at: later,
          carried: yield* carryAll("campaign"),
        });
        return { before, cancelled, journal: yield* journaled(cancelled), tree, after, answer, done };
      }),
    );
    expect(result.before.map(({ question }) => question.id)).toEqual(["q-cutoff"]);
    // Aldric's copy of the question settled when he passed it up (#573); the cancel reaches him as a failure item.
    expect(tags(result.cancelled.entries)).toEqual([
      "TaskStateChanged",
      "CheckpointRecorded",
      "QuestionWithdrawn",
      "BackpackItemRecorded",
      "QuestSummaryChanged",
    ]);
    expect(result.cancelled.entries[2]?.payload).toMatchObject({
      question: { id: "q-cutoff", state: "withdrawn", answer: null, recipientId: null, chain: [ALDRIC] },
    });
    expect(result.journal.stored).toEqual(result.journal.returned);
    expect(result.tree.questions.map((each) => [each.id, each.state])).toEqual([["q-cutoff", "withdrawn"]]);
    expect(result.after).toEqual([]);
    expect(result.answer).toMatchObject({ _tag: "TaskRefused", reason: "task-ended" });
    expect(result.done.value.state).toBe("completed");
  });

  // covers OR-004, IN-006
  it("[TC-OR-168] withdraws a question still with its lead when its Task fails, resolving the lead's copy as late", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const sql = yield* SqlClient.SqlClient;
        const ask = (id: string) =>
          tasks.askQuestion({
            id: QuestionId.make(id),
            taskId: TaskId.make("build"),
            askerId: ADA,
            text: id,
            createdAt: now,
          });
        yield* ask("q-tone");
        yield* ask("q-done");
        yield* tasks.answerQuestion(QuestionId.make("q-done"), { _tag: "Lead", agentId: ALDRIC }, "Playful", now);
        const ledgerBefore = Option.getOrThrow(yield* tasks.readLedger(TaskId.make("campaign")));
        const build = yield* latest("build");
        const failed = yield* tasks.moveTask(build.id, build.revision, "failed", later);
        const ledgerAfter = Option.getOrThrow(yield* tasks.readLedger(TaskId.make("campaign")));
        const tree = Option.getOrThrow(yield* tasks.readTree(TaskId.make("build")));
        const items = yield* sql<{
          readonly kind: string;
          readonly state: string;
          readonly disposition: string | null;
        }>`
          SELECT kind, state, disposition FROM backpack_items WHERE task_id = 'build' AND kind = 'question'
          ORDER BY recorded_sequence`;
        return { ledgerBefore, failed, ledgerAfter, tree, items };
      }),
    );
    expect(result.ledgerBefore.open.filter((entry) => entry._tag === "Question")).toHaveLength(1);
    expect(tags(result.failed.entries)).toEqual([
      "TaskStateChanged",
      "CheckpointRecorded",
      "QuestionWithdrawn",
      "BackpackItemChanged",
      "BackpackItemRecorded",
      "QuestSummaryChanged",
    ]);
    // An answered question stays answered; only the open one is withdrawn.
    expect(Object.fromEntries(result.tree.questions.map((each) => [each.id, each.state]))).toEqual({
      "q-tone": "withdrawn",
      "q-done": "answered",
    });
    expect(result.ledgerAfter.open.map((entry) => entry._tag)).not.toContain("Question");
    expect(result.items.map((each) => each.state)).toEqual(["resolved", "resolved"]);
    expect(JSON.parse(result.items[0]?.disposition ?? "null")).toMatchObject({ _tag: "late" });
    // The lead's copy of the question it answered settled with its answer (#573).
    expect(JSON.parse(result.items[1]?.disposition ?? "null")).toMatchObject({ _tag: "answered" });
  });

  // covers OR-003, OR-004
  it("[TC-OR-005] records milestones and reports by their source, and hands an artifact to a Task in the same tree once", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = TaskId.make("copy");
        const report = (
          id: string,
          source: "planned" | "unplanned",
          kind: "milestone" | "finding" | "progress",
          milestone: string | null,
        ) =>
          tasks.recordCheckpoint({
            id: CheckpointId.make(id),
            taskId: copy,
            source,
            kind,
            milestoneId: milestone === null ? null : MilestoneId.make(milestone),
            summary: `${kind} ${id}`,
            createdAt: later,
          });
        const reached = yield* report("c1", "planned", "milestone", "m-draft");
        const twice = yield* report("c2", "planned", "milestone", "m-draft").pipe(Effect.flip);
        const wrongSource = yield* report("c3", "unplanned", "milestone", "m-draft").pipe(Effect.flip);
        const finding = yield* report("c4", "unplanned", "finding", null);

        const task = Option.getOrThrow(yield* tasks.readTree(copy)).tasks[0];
        if (task === undefined) throw new Error("no Task");
        const started = yield* tasks.startAttempt(copy, task.revision, attempt("a1"));
        yield* tasks.completeTask(copy, started.value.task.revision, {
          summary: "Copy",
          attemptId: AttemptId.make("a1"),
          artifacts: [{ id: ArtifactId.make("copy-doc"), kind: "file", label: "Copy", value: "/work/copy.md" }],
          at: later,
          carried: yield* carryAll("copy"),
        });
        yield* tasks.createTask({ task: newTask("elsewhere", PIP, null), delegation: null, milestones: [] });
        const handed = yield* tasks.handOff(ArtifactId.make("copy-doc"), TaskId.make("build"), later);
        const again = yield* tasks.handOff(
          ArtifactId.make("copy-doc"),
          TaskId.make("build"),
          "2026-11-02T00:00:00.000Z",
        );
        const outside = yield* tasks
          .handOff(ArtifactId.make("copy-doc"), TaskId.make("elsewhere"), later)
          .pipe(Effect.flip);
        const tree = Option.getOrThrow(yield* tasks.readTree(TaskId.make("campaign")));
        return { reached, twice, wrongSource, finding, handed, again, outside, tree };
      }),
    );

    expect(tags(result.reached.entries)).toEqual(["CheckpointRecorded", "BackpackItemRecorded"]);
    expect(result.reached.entries[0]?.payload).toMatchObject({
      checkpoint: { source: "planned", kind: "milestone", milestoneId: "m-draft" },
      milestone: { id: "m-draft", reachedAt: later },
    });
    expect(result.twice).toMatchObject({ _tag: "TaskRefused", reason: "milestone-mismatch" });
    expect(result.wrongSource).toMatchObject({ _tag: "TaskRefused", reason: "checkpoint-kind" });
    expect(result.finding.value).toMatchObject({ source: "unplanned", kind: "finding", attemptId: null });
    expect(tags(result.handed.entries)).toEqual(["HandedOff", "BackpackItemRecorded"]);
    expect(result.handed.entries[0]?.correlation).toEqual({ agentId: ADA, threadId, messageId: null });
    expect(result.again.entries).toEqual([]);
    expect(result.again.value).toEqual(result.handed.value);
    expect(result.outside).toMatchObject({ _tag: "TaskRefused", reason: "artifact-outside-tree" });
    expect(result.tree.handOffs).toEqual([result.handed.value]);
    expect(result.tree.milestones[0]?.reachedAt).toBe(later);
  });

  // covers EX-001, EX-002, OR-002, OR-006
  it("[TC-OR-008] keeps a Task's result, retries, ends and dependencies consistent with the rest of its tree", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const latest = (id: string) =>
          tasks.readTree(TaskId.make(id)).pipe(
            Effect.map((tree) => {
              const task = Option.getOrThrow(tree).tasks[0];
              if (task === undefined) throw new Error("no Task");
              return task;
            }),
          );
        const reason = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => ("reason" in error ? error.reason : error._tag)),
          );
        const copy = TaskId.make("copy");
        const campaignId = TaskId.make("campaign");

        // Two changes decided on the same revision: one wins, the other is stale.
        const created = yield* latest("copy");
        const raced = yield* Effect.all(
          [
            Effect.result(tasks.startAttempt(copy, created.revision, attempt("a1"))),
            Effect.result(tasks.startAttempt(copy, created.revision, attempt("a-race"))),
          ],
          { concurrency: "unbounded" },
        );
        yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "Lost" },
          at: now,
        });
        const failed = yield* tasks.moveTask(copy, (yield* latest("copy")).revision, "failed", now);
        const retry = yield* tasks.startAttempt(copy, failed.value.revision, attempt("a2"));
        const staleResult = yield* reason(
          tasks.completeTask(copy, retry.value.task.revision, {
            summary: "Old",
            attemptId: AttemptId.make("a1"),
            artifacts: [],
            at: now,
          }),
        );
        // The parent cannot end while its members still work.
        const root = yield* latest("campaign");
        yield* tasks.startAttempt(campaignId, root.revision, attempt("a-root"));
        yield* tasks.updateAttempt(AttemptId.make("a-root"), {
          _tag: "Ended",
          end: { _tag: "Finished", outcome: null },
          at: now,
        });
        const failOpen = yield* reason(tasks.moveTask(campaignId, (yield* latest("campaign")).revision, "failed", now));
        // Ada's Task cannot start before Quill's copy completes (#667).
        const build = yield* latest("build");
        const waiting = yield* reason(tasks.startAttempt(build.id, build.revision, attempt("a-build")));
        const notSibling = yield* reason(
          tasks.createTask({ task: newTask("ada-step", ADA, "build", ["campaign"]), delegation: null, milestones: [] }),
        );
        const noThread = yield* reason(
          tasks.createTask({
            task: { ...newTask("lost", PIP, null), threadId: ThreadId.make("nowhere") },
            delegation: null,
            milestones: [],
          }),
        );
        // A Quest on the lead's own step keeps its lead's depth; steps never add depth.
        yield* tasks.createTask({ task: newTask("aldric-step", ALDRIC, "campaign"), delegation: null, milestones: [] });
        const stepQuest = yield* tasks.startQuest({
          id: QuestId.make("q-step"),
          taskId: TaskId.make("aldric-step"),
          goal: "A side quest",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        return { raced, staleResult, failOpen, waiting, notSibling, noThread, stepQuest };
      }),
    );

    expect(result.raced.map((each) => (each._tag === "Success" ? "won" : each.failure._tag)).sort()).toEqual([
      "StaleTask",
      "won",
    ]);
    expect(result.staleResult).toBe("attempt-mismatch");
    expect(result.failOpen).toBe("children-open");
    expect(result.waiting).toBe("dependencies-open");
    expect(result.notSibling).toBe("dependency-outside-tree");
    expect(result.noThread).toBe("thread-missing");
    expect(result.stepQuest.value).toMatchObject({ parentQuestId: "q1", depth: 1 });
  });

  // covers EX-001, OR-006
  it("[TC-OR-009] refuses a retry under an ended Task, and reopens a failed Quest with its retried Task", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* TaskRepository;
        yield* tasks.createTask({ task: newTask("top", ALDRIC, null), delegation: null, milestones: [] });
        yield* tasks.startQuest({
          id: QuestId.make("q-top"),
          taskId: TaskId.make("top"),
          goal: "Goal",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        const member = yield* tasks.createTask({
          task: newTask("member", QUILL, "top"),
          delegation: brief("d-m"),
          milestones: [],
        });
        const memberFailed = yield* tasks.moveTask(member.value.id, member.value.revision, "failed", now);
        const topTree = Option.getOrThrow(yield* tasks.readTree(TaskId.make("top")));
        const top = topTree.tasks[0];
        if (top === undefined) throw new Error("no Task");
        const topFailed = yield* tasks.moveTask(top.id, top.revision, "failed", now);
        const retryUnder = yield* tasks
          .startAttempt(member.value.id, memberFailed.value.revision, attempt("a-m"))
          .pipe(Effect.flip);
        const retryTop = yield* tasks.startAttempt(top.id, topFailed.value.revision, attempt("a-top"));
        return { topFailed, retryUnder, retryTop };
      }),
    );

    expect(result.topFailed.entries[0]?.payload).toMatchObject({ quest: { id: "q-top", state: "failed" } });
    expect(result.retryUnder).toMatchObject({ _tag: "TaskRefused", reason: "parent-ended" });
    expect(result.retryTop.entries[0]?.payload).toMatchObject({
      task: { id: "top", state: "active" },
      quest: { id: "q-top", state: "active", endedAt: null },
    });
  });
  // covers OR-001, UX-001, CH-005
  it("[TC-OR-021] lists a hob's Tasks on other hobs' Quests with their Quest until the Quest ends", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const ids = (agentId: AgentId) =>
          tasks
            .listMemberWork(agentId)
            .pipe(Effect.map((work) => work.map((each) => [each.task.id, each.quest.id, each.delegation.leadId])));
        const quill = yield* ids(QUILL);
        const ada = yield* ids(ADA);
        const lead = yield* ids(ALDRIC);
        const copy = Option.getOrThrow(yield* tasks.readTree(TaskId.make("copy"))).tasks[0];
        if (copy === undefined) throw new Error("no Task");
        yield* tasks.moveTask(copy.id, copy.revision, "failed", later);
        const ended = yield* tasks.listMemberWork(QUILL);
        const tree = Option.getOrThrow(yield* tasks.readTree(TaskId.make("campaign")));
        const build = tree.tasks.find((task) => task.id === "build");
        const top = tree.tasks[0];
        if (build === undefined || top === undefined) throw new Error("no Task");
        yield* tasks.moveTask(build.id, build.revision, "cancelled", later);
        yield* tasks.moveTask(top.id, top.revision, "failed", later);
        const afterQuest = yield* ids(QUILL);
        return { quill, ada, lead, ended, afterQuest };
      }),
    );

    expect(result.quill).toEqual([["copy", "q1", ALDRIC]]);
    expect(result.ada).toEqual([["build", "q1", ALDRIC]]);
    // The lead's own Task is not member work.
    expect(result.lead).toEqual([]);
    // A member's ended Task stays listed, with its outcome, while its Quest is active.
    expect(result.ended.map((each) => [each.task.id, each.task.state, each.quest.state])).toEqual([
      ["copy", "failed", "active"],
    ]);
    expect(result.afterQuest).toEqual([]);
  });
  // covers OR-001, UX-001
  it("[TC-OR-023] gives a member's work on a nested Quest the hob whose thread the request came from", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        yield* tasks.startQuest({
          id: QuestId.make("q2"),
          taskId: TaskId.make("build"),
          goal: "Keywords",
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: now,
        });
        yield* tasks.createTask({
          task: newTask("keywords", PIP, "build"),
          delegation: brief("d-keywords"),
          milestones: [],
        });
        return { pip: yield* tasks.listMemberWork(PIP), quill: yield* tasks.listMemberWork(QUILL) };
      }),
    );

    // Ada leads Pip's Quest, but it is followed in Aldric's thread.
    expect(result.pip.map((each) => [each.task.id, each.quest.id, each.quest.leadId, each.threadAgentId])).toEqual([
      ["keywords", "q2", ADA, ALDRIC],
    ]);
    expect(result.quill.map((each) => [each.quest.leadId, each.threadAgentId])).toEqual([[ALDRIC, ALDRIC]]);
  });
});

/** A request from `agentId`'s turn on `taskId` in the tree under `rootId`, or on no Task. */
const approval = (id: string, agentId: AgentId, taskId: string | null, rootId = "campaign") =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId,
    threadId,
    messageId: null,
    taskId: taskId === null ? null : TaskId.make(taskId),
    rootTaskId: taskId === null ? null : TaskId.make(rootId),
    stepId: `step-${id}`,
    tool: "Bash",
    operation: "run-commands",
    targets: ["/code"],
    arguments: { command: "pnpm test" },
    label: "Running pnpm test",
    reason: "Commands ask first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1-0123456789abcdef",
    state: "pending",
    denyReason: null,
    createdAt: later,
    decidedAt: null,
  });

describe("a hob's History", () => {
  // covers OR-001, UX-001
  it("[TC-OR-491] reads a hob's own work and its party's, leaving out steps, other hobs and questions a lead kept", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const approvals = yield* ApprovalRepository;
        yield* tasks.createTask({ task: newTask("research", ALDRIC, "campaign"), delegation: null, milestones: [] });
        yield* tasks.createTask({ task: newTask("other", PIP, null), delegation: null, milestones: [] });
        yield* approvals.insert(approval("a-quill", QUILL, "copy"));
        yield* approvals.insert(approval("a-aldric", ALDRIC, null));
        yield* approvals.insert(approval("a-pip", PIP, "other", "other"));
        const ask = (id: string, taskId: string, askerId: AgentId) =>
          tasks.askQuestion({
            id: QuestionId.make(id),
            taskId: TaskId.make(taskId),
            askerId,
            text: id,
            createdAt: now,
          });
        // Quill's question stops at Aldric; Ada's climbs to you.
        yield* ask("q-quill", "copy", QUILL);
        yield* ask("q-ada", "build", ADA);
        yield* tasks.escalateQuestion(QuestionId.make("q-ada"), ALDRIC);
        const copy = yield* latest("copy");
        yield* tasks.moveTask(copy.id, copy.revision, "failed", later);
        const ids = (agentId: AgentId) =>
          tasks.readHistoryRecords(agentId).pipe(
            Effect.map((records) => ({
              tasks: records.tasks.map((each) => [each.id, each.state]),
              delegations: records.delegations.map((each) => each.id),
              quests: records.quests.map((each) => each.id),
              approvals: records.approvals.map((each) => each.id),
              questions: records.questions.map((each) => each.id),
            })),
          );
        return { aldric: yield* ids(ALDRIC), quill: yield* ids(QUILL), pip: yield* ids(PIP) };
      }),
    );

    // The lead reads the Task you asked for and its party's Tasks, never its own step.
    expect(result.aldric).toEqual({
      tasks: [
        ["campaign", "queued"],
        ["copy", "failed"],
        ["build", "queued"],
      ],
      delegations: ["d-copy", "d-build"],
      quests: ["q1"],
      approvals: ["a-aldric", "a-quill"],
      questions: ["q-ada"],
    });
    // A member reads only its own Task, with the Quest it serves.
    expect(result.quill).toEqual({
      tasks: [["copy", "failed"]],
      delegations: ["d-copy"],
      quests: ["q1"],
      approvals: ["a-quill"],
      questions: [],
    });
    expect(result.pip).toEqual({
      tasks: [["other", "queued"]],
      delegations: [],
      quests: [],
      approvals: ["a-pip"],
      questions: [],
    });
  });
});

describe("waits and Task tool calls", () => {
  // covers OR-003, EX-002
  it("[TC-OR-019] a wait records what the owner waits for and shows the Task waiting", async () => {
    await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const id = TaskId.make("campaign");
        const started = yield* tasks.startAttempt(
          id,
          (yield* tasks.readTree(id)).pipe(Option.getOrThrow).tasks[0]?.revision ?? 0,
          attempt("a1"),
        );
        const on = [TaskId.make("copy"), TaskId.make("build")];
        const waited = yield* tasks.waitFor(id, started.value.task.revision, { on, mode: "all", at: later });
        expect(waited.value.task.state).toBe("waiting");
        expect(tags(waited.entries)).toEqual(["TaskStateChanged", "CheckpointRecorded"]);
        const { stored, returned } = yield* journaled(waited);
        expect(stored).toEqual(returned);
        // A new wait replaces the last one; the Task already waits, so no new automatic checkpoint.
        const again = yield* tasks.waitFor(id, waited.value.task.revision, {
          on: [TaskId.make("copy")],
          mode: "any",
          at: later,
        });
        expect(tags(again.entries)).toEqual(["TaskStateChanged"]);
        // The change carries the new wait, so a screen shows who the Task waits on without reading again.
        expect(again.entries[0]?.payload).toMatchObject({ wait: { taskId: id, on: ["copy"], mode: "any" } });
        const tree = (yield* tasks.readTree(id)).pipe(Option.getOrThrow);
        expect(tree.waits).toEqual([expect.objectContaining({ taskId: id, on: ["copy"], mode: "any" })]);
        const outside = yield* Effect.flip(
          tasks.waitFor(id, again.value.task.revision, { on: [id], mode: "all", at: later }),
        );
        expect(outside).toMatchObject({ _tag: "TaskRefused", reason: "wait-outside-subtree" });
        expect(yield* tasks.openTaskCount(QUILL)).toBe(1);
        expect(yield* tasks.openTaskCount(PIP)).toBe(0);
      }),
    );
  });

  // covers OR-001, EX-001
  it("[TC-OR-020] a call runs once per hob and key, and a refused one leaves nothing behind", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* TaskRepository;
        const ledger = yield* TaskToolCalls;
        const journal = yield* EventJournal;
        let runs = 0;
        const create = (id: string) =>
          Effect.gen(function* () {
            runs++;
            const created = yield* tasks.createTask({
              task: newTask(id, ALDRIC, null),
              delegation: null,
              milestones: [],
            });
            return { done: { message: `Created ${id}`, details: { task_id: id } }, entries: created.entries };
          });
        const call = {
          agentId: ALDRIC,
          scope: "task:top",
          key: "k1",
          tool: "plan_steps" as const,
          input: '{"steps":[]}',
          at: now,
        };
        const first = yield* ledger.once(call, create("one"));
        expect(first.entries).toHaveLength(1);
        const again = yield* ledger.once(call, create("two"));
        expect(again).toEqual({ done: first.done, entries: [] });
        expect(runs).toBe(1);
        expect(Option.isNone(yield* tasks.readTree(TaskId.make("two")))).toBe(true);
        // The same key for another call is refused; another hob's key is its own.
        const reused = yield* Effect.flip(ledger.once({ ...call, input: '{"steps":[1]}' }, create("three")));
        expect(reused).toMatchObject({ _tag: "TaskToolRefused", reason: "key-reused" });
        yield* ledger.once({ ...call, agentId: QUILL }, create("four"));
        expect(runs).toBe(2);

        // A call refused after a write rolls the write back and keeps its key free.
        const before = yield* journal.head;
        const failing = Effect.flatMap(create("five"), () => Effect.fail("refused" as const));
        expect(yield* Effect.flip(ledger.once({ ...call, key: "k2" }, failing))).toBe("refused");
        expect(Option.isNone(yield* tasks.readTree(TaskId.make("five")))).toBe(true);
        expect(yield* journal.head).toEqual(before);
        const retried = yield* ledger.once({ ...call, key: "k2" }, create("six"));
        expect(retried.done.message).toBe("Created six");

        // Two deliveries of one call at once: the second waits for the first and returns its result.
        const runsBefore = runs;
        const both = yield* Effect.all(
          [ledger.once({ ...call, key: "k3" }, create("seven")), ledger.once({ ...call, key: "k3" }, create("eight"))],
          { concurrency: 2 },
        );
        expect(both[1].done).toEqual(both[0].done);
        expect(runs).toBe(runsBefore + 1);
      }),
    );
  });

  // covers EX-001, OR-006
  it("[TC-OR-140] a retry queues a failed member's Task for a new Attempt of the same Task, never under a cancel", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = TaskId.make("copy");
        yield* tasks.startAttempt(copy, (yield* latest("copy")).revision, attempt("a1"));
        yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "It broke." },
          at: now,
        });
        const failed = yield* tasks.moveTask(copy, (yield* latest("copy")).revision, "failed", now);
        const notFailed = yield* tasks
          .retryTask(TaskId.make("build"), (yield* latest("build")).revision, now)
          .pipe(Effect.flip);
        const top = yield* tasks
          .retryTask(TaskId.make("campaign"), (yield* latest("campaign")).revision, now)
          .pipe(Effect.flip);
        const retried = yield* tasks.retryTask(copy, failed.value.revision, later);
        const again = yield* tasks.startAttempt(copy, retried.value.revision, attempt("a2"));
        return { notFailed, top, retried, again, tree: Option.getOrThrow(yield* tasks.readTree(copy)) };
      }),
    );

    expect(result.notFailed).toMatchObject({ _tag: "IllegalTaskTransition", from: "queued", to: "queued" });
    expect(result.top).toMatchObject({ _tag: "TaskRefused", reason: "top-task" });
    expect(result.retried.value).toMatchObject({ id: "copy", state: "queued", ownerId: QUILL });
    expect(result.retried.entries[0]?.payload).toMatchObject({
      _tag: "TaskStateChanged",
      control: { _tag: "Retried", delegation: { childTaskId: "copy", memberId: QUILL } },
    });
    expect(result.again.value.attempt.number).toBe(2);
    expect(result.tree.attempts.map((each) => [each.number, each.state])).toEqual([
      [1, "failed"],
      [2, "starting"],
    ]);
  });

  // covers OR-006
  it("[TC-OR-141] nothing new starts under a Task being cancelled, and it reports and asks nothing more", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = TaskId.make("copy");
        yield* tasks.moveTask(copy, (yield* latest("copy")).revision, "failed", now);
        const top = yield* latest("campaign");
        const activeTop = yield* tasks.startAttempt(top.id, top.revision, attempt("a-top"));
        yield* tasks.moveTask(top.id, activeTop.value.task.revision, "cancelling", now);
        const child = yield* tasks
          .createTask({ task: newTask("late", PIP, "campaign"), delegation: brief("d-late"), milestones: [] })
          .pipe(Effect.flip);
        const retry = yield* tasks.retryTask(copy, (yield* latest("copy")).revision, now).pipe(Effect.flip);
        const build = TaskId.make("build");
        const start = yield* tasks
          .startAttempt(build, (yield* latest("build")).revision, attempt("a-b"))
          .pipe(Effect.flip);
        const report = yield* tasks
          .recordCheckpoint({
            id: CheckpointId.make("c-late"),
            taskId: top.id,
            source: "unplanned",
            kind: "finding",
            milestoneId: null,
            summary: "Found something",
            createdAt: now,
          })
          .pipe(Effect.flip);
        const ask = yield* tasks
          .askQuestion({
            id: QuestionId.make("q-late"),
            taskId: top.id,
            askerId: ALDRIC,
            text: "Go on?",
            createdAt: now,
          })
          .pipe(Effect.flip);
        return { child, retry, start, report, ask, cancelling: yield* tasks.listCancellingTasks };
      }),
    );

    expect(result.child).toMatchObject({ _tag: "TaskRefused", reason: "parent-cancelling" });
    expect(result.retry).toMatchObject({ _tag: "TaskRefused", reason: "parent-cancelling" });
    expect(result.start).toMatchObject({ _tag: "TaskRefused", reason: "parent-cancelling" });
    // What a Task being cancelled reports or asks would only wake its lead about work that is ending.
    expect(result.report).toMatchObject({ _tag: "TaskRefused", reason: "task-cancelling" });
    expect(result.ask).toMatchObject({ _tag: "TaskRefused", reason: "task-cancelling" });
    expect(result.cancelling.map((each) => each.id)).toEqual(["campaign"]);
  });

  // covers OR-006
  it("[TC-OR-142] a reassignment gives a member's Task to another hob and keeps its id and Attempts", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = TaskId.make("copy");
        const started = yield* tasks.startAttempt(copy, (yield* latest("copy")).revision, attempt("a1"));
        const reassign = (ownerId: AgentId) =>
          Effect.flatMap(latest("copy"), (task) => tasks.reassignTask(copy, task.revision, ownerId, later));
        const live = yield* reassign(PIP).pipe(Effect.flip);
        yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Finished", outcome: null },
          at: now,
        });
        const toLead = yield* reassign(ALDRIC).pipe(Effect.flip);
        const toSelf = yield* reassign(QUILL).pipe(Effect.flip);
        const top = yield* tasks
          .reassignTask(TaskId.make("campaign"), (yield* latest("campaign")).revision, PIP, later)
          .pipe(Effect.flip);
        const moved = yield* reassign(PIP);
        return {
          started,
          live,
          toLead,
          toSelf,
          top,
          moved,
          tree: Option.getOrThrow(yield* tasks.readTree(copy)),
          pipWork: yield* tasks.listMemberWork(PIP),
          quillWork: yield* tasks.listMemberWork(QUILL),
        };
      }),
    );

    expect(result.live).toMatchObject({ _tag: "TaskRefused", reason: "attempt-live" });
    expect(result.toLead).toMatchObject({ _tag: "TaskRefused", reason: "lineage-owner" });
    expect(result.toSelf).toMatchObject({ _tag: "TaskRefused", reason: "same-owner" });
    expect(result.top).toMatchObject({ _tag: "TaskRefused", reason: "not-delegated" });
    expect(result.moved.value).toMatchObject({ id: "copy", ownerId: PIP, state: "queued" });
    expect(result.moved.entries[0]?.payload).toMatchObject({
      control: { _tag: "Reassigned", from: QUILL, delegation: { memberId: PIP, brief: "Delegated d-copy" } },
    });
    // The Attempt Quill ran stays his; the Delegation now names Pip, so the work shows as Pip's.
    expect(result.tree.attempts.map((each) => each.agentId)).toEqual([QUILL]);
    expect(result.tree.delegations.map((each) => each.memberId)).toEqual([PIP]);
    expect(result.pipWork.map((each) => each.task.id)).toEqual(["copy"]);
    expect(result.quillWork).toEqual([]);
  });

  // covers IN-007, OR-006
  it("[TC-IN-1087-01] closes the stuck work about a Task once its earlier owner hands it on, and once it ends (#1087)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const sql = yield* SqlClient.SqlClient;
        // The hob's tries at starting the Task ran out: its item fails with a blocker for you.
        const stick = (recipientId: AgentId) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly id: string }>`UPDATE backpack_items SET state = 'failed'
              WHERE task_id = 'copy' AND recipient_id = ${recipientId} AND state = 'pending' RETURNING id`;
            for (const { id } of rows) {
              yield* sql`INSERT INTO backpack_blockers (item_id, number, reason, next_action, diagnostic, last_end,
                  after_deliveries, raised_at, decision, decided_at)
                VALUES (${id}, 1, 'retries-exhausted', 'retry', NULL, 'interrupted', 3, ${now}, NULL, NULL)`;
            }
          });
        const items = sql<{
          readonly recipientId: string;
          readonly state: string;
          readonly disposition: string | null;
        }>`
          SELECT recipient_id, state, disposition FROM backpack_items WHERE task_id = 'copy' ORDER BY recorded_sequence`;
        yield* stick(QUILL);
        const copy = TaskId.make("copy");
        const reassigned = yield* tasks.reassignTask(copy, (yield* latest("copy")).revision, PIP, later);
        const afterReassign = yield* items;
        yield* stick(PIP);
        const failed = yield* tasks.moveTask(copy, (yield* latest("copy")).revision, "failed", later);
        return { reassigned, afterReassign, failed, afterEnd: yield* items };
      }),
    );
    // Quill's stuck item closes as late with the reassignment, and Pip gets the Task as new work.
    expect(tags(result.reassigned.entries)).toEqual([
      "TaskStateChanged",
      "BackpackItemChanged",
      "BackpackItemRecorded",
    ]);
    expect(result.afterReassign.map((each) => [each.recipientId, each.state])).toEqual([
      [QUILL, "resolved"],
      [PIP, "pending"],
    ]);
    expect(JSON.parse(result.afterReassign[0]?.disposition ?? "null")).toMatchObject({ _tag: "late" });
    // Pip's stuck item closes once the Task ends, so nothing is left for you to choose.
    expect(tags(result.failed.entries)).toContain("BackpackItemChanged");
    expect(result.afterEnd.filter((each) => each.recipientId === PIP).map((each) => each.state)).toEqual(["resolved"]);
    expect(JSON.parse(result.afterEnd.find((each) => each.recipientId === PIP)?.disposition ?? "null")).toMatchObject({
      _tag: "late",
    });
  });
});

// Issue #702: what the third run's records left out or got wrong.
describe("Task records the third run found gaps in", () => {
  // covers EX-001, PE-008
  it("[TC-DP-240] an Attempt started with no policy version takes the first one its session reports, and keeps it", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = yield* latest("copy");
        const a1 = AttemptId.make("a1");
        yield* tasks.startAttempt(copy.id, copy.revision, { ...attempt("a1"), policyVersion: null });
        const unknown = Option.getOrThrow(yield* tasks.readTree(copy.id)).attempts[0]?.policyVersion;
        yield* tasks.updateAttempt(a1, { _tag: "Running", sessionId: "s1", policyVersion: "r3-first", at: now });
        yield* tasks.updateAttempt(a1, {
          _tag: "Ended",
          end: { _tag: "Finished", outcome: "The turn finished." },
          sessionId: "s1",
          policyVersion: "r3-second",
          at: later,
        });
        return { unknown, ended: Option.getOrThrow(yield* tasks.readTree(copy.id)).attempts[0] };
      }),
    );
    expect(result.unknown).toBeNull();
    expect(result.ended).toMatchObject({
      policyVersion: "r3-first",
      outcome: "The turn finished.",
      state: "completed",
    });
  });

  // covers ADR 036 (The read-the-web mark), ADR 013
  it("[TC-DP-1268-01] an Attempt's read-the-web mark is journaled as it changes: since its first read, naming its last", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = yield* latest("copy");
        const a1 = AttemptId.make("a1");
        yield* tasks.startAttempt(copy.id, copy.revision, attempt("a1"));
        const first = yield* tasks.markAttemptReadWeb(a1, { since: now, source: "https://a.test/page" });
        const again = yield* tasks.markAttemptReadWeb(a1, { since: later, source: "https://a.test/page" });
        const next = yield* tasks.markAttemptReadWeb(a1, { since: later, source: "https://b.test/page" });
        const missing = yield* tasks.markAttemptReadWeb(AttemptId.make("nowhere"), { since: now, source: "x" });
        return {
          first: Option.getOrThrow(first).entries.map((entry) => entry.payload),
          again,
          next: Option.getOrThrow(next).value,
          missing,
          stored: Option.getOrThrow(yield* tasks.readTree(copy.id)).attempts[0],
        };
      }),
    );
    expect(result.first).toMatchObject([
      {
        _tag: "AttemptReadWeb",
        taskId: "copy",
        attempt: { id: "a1", readWeb: { since: now, source: "https://a.test/page" } },
      },
    ]);
    expect(Option.isNone(result.again)).toBe(true);
    expect(result.next.readWeb).toEqual({ since: now, source: "https://b.test/page" });
    expect(Option.isNone(result.missing)).toBe(true);
    expect(result.stored?.readWeb).toEqual({ since: now, source: "https://b.test/page" });
  });

  // covers OR-003
  it("[TC-OR-520] a Task that ends drops its wait, whether it completes or fails", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const top = yield* latest("campaign");
        const started = yield* tasks.startAttempt(top.id, top.revision, attempt("a-lead"));
        const on = [TaskId.make("copy"), TaskId.make("build")];
        yield* tasks.waitFor(top.id, started.value.task.revision, { on, mode: "all", at: now, keepActive: true });
        const waiting = Option.getOrThrow(yield* tasks.readTree(top.id)).waits.map((each) => each.taskId);
        for (const id of ["build", "copy"]) {
          const each = yield* latest(id);
          yield* tasks.moveTask(each.id, each.revision, "cancelled", now);
        }
        const lead = yield* latest("campaign");
        yield* tasks.completeTask(lead.id, lead.revision, {
          summary: "Done without them",
          attemptId: AttemptId.make("a-lead"),
          artifacts: [],
          at: later,
          carried: yield* carryAll("campaign"),
        });
        const completed = Option.getOrThrow(yield* tasks.readTree(top.id)).waits;

        // A Task that waits on its own step, then fails, drops its wait too.
        const quill = yield* tasks.createTask({ task: newTask("solo", QUILL, null), delegation: null, milestones: [] });
        const solo = yield* tasks.startAttempt(quill.value.id, quill.value.revision, attempt("a-solo"));
        yield* tasks.createTask({ task: newTask("draft", QUILL, "solo"), delegation: null, milestones: [] });
        const open = yield* latest("solo");
        yield* tasks.waitFor(open.id, open.revision, { on: [TaskId.make("draft")], mode: "all", at: now });
        const draft = yield* latest("draft");
        yield* tasks.moveTask(draft.id, draft.revision, "cancelled", now);
        yield* tasks.updateAttempt(solo.value.attempt.id, {
          _tag: "Ended",
          end: { _tag: "Stopped", reason: "Stopped" },
          at: now,
        });
        const before = yield* latest("solo");
        yield* tasks.moveTask(before.id, before.revision, "failed", later, { reason: "Its hob was retired." });
        const failed = Option.getOrThrow(yield* tasks.readTree(before.id)).waits;
        return { waiting, completed, failed };
      }),
    );
    expect(result.waiting).toEqual(["campaign"]);
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  // covers OR-004, OR-005
  it("[TC-OR-521] the reason the hub records with a move is the hub's own blocker, which no report can claim", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        const copy = yield* latest("copy");
        const started = yield* tasks.startAttempt(copy.id, copy.revision, attempt("a1"));
        const ended = yield* tasks.updateAttempt(started.value.attempt.id, {
          _tag: "Ended",
          end: { _tag: "Finished", outcome: "The turn finished." },
          at: now,
        });
        yield* tasks.moveTask(copy.id, ended.value.task.revision, "blocked", now, {
          reason: "Its member ended a turn without completing it.",
        });
        const forged = yield* tasks
          .recordCheckpoint({
            id: CheckpointId.make("forged"),
            taskId: copy.id,
            source: "automatic",
            kind: "blocker",
            milestoneId: null,
            summary: "Not the hub",
            createdAt: later,
          })
          .pipe(Effect.flip);
        const tree = Option.getOrThrow(yield* tasks.readTree(copy.id));
        return { blockers: tree.checkpoints.filter((each) => each.kind === "blocker"), forged };
      }),
    );
    expect(result.blockers.map((each) => [each.source, each.summary])).toEqual([
      ["automatic", "Its member ended a turn without completing it."],
    ]);
    expect(result.forged).toMatchObject({ _tag: "TaskRefused", reason: "checkpoint-kind" });
  });
});

describe("Task records the Quest room run found gaps in", () => {
  // covers EX-001, OR-006
  it("[TC-OR-594] a Task that completed keeps the time it ended when its turn ends after it (#1007)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* campaign;
        const tasks = yield* TaskRepository;
        yield* tasks.createTask({ task: newTask("alone", PIP, null), delegation: null, milestones: [] });
        const copy = yield* latest("alone");
        const started = yield* tasks.startAttempt(copy.id, copy.revision, attempt("a1"));
        const done = yield* tasks.completeTask(copy.id, started.value.task.revision, {
          summary: "Done",
          attemptId: AttemptId.make("a1"),
          artifacts: [],
          at: now,
          carried: yield* carryAll("alone"),
        });
        const ended = yield* tasks.updateAttempt(AttemptId.make("a1"), {
          _tag: "Ended",
          end: { _tag: "Finished", outcome: null },
          at: later,
        });
        return { done: done.value, ended: ended.value, stored: yield* latest("alone") };
      }),
    );
    expect(result.done.updatedAt).toBe(now);
    expect(result.ended.attempt.endedAt).toBe(later);
    expect(result.ended.task.updatedAt).toBe(now);
    expect(result.stored.updatedAt).toBe(now);
    expect(result.stored.revision).toBe(result.ended.task.revision);
  });
});
