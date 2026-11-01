import { HobbotsRepository, type NewAttempt, type NewTask, TaskRepository, TaskToolCalls } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  AttemptId,
  CheckpointId,
  type Committed,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  type EventEnvelope,
  MilestoneId,
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
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | TaskToolCalls | EventJournal | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

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
    // Each change is journaled with its event, correlated with the Task's owner and thread.
    expect(tags(result.step.entries)).toEqual(["TaskCreated"]);
    expect(result.step.entries[0]?.correlation).toEqual({ agentId: ADA, threadId, messageId: null });
    expect(result.step.value.revision).toBe(result.step.entries[0]?.sequence);
    expect(tags(result.nested.entries)).toEqual(["QuestStarted"]);
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
        const running = yield* tasks.updateAttempt(AttemptId.make("a1"), {
          state: "running",
          sessionId: "s1",
          at: now,
        });
        const stale = yield* tasks.moveTask(copy, created.revision, "waiting", now).pipe(Effect.flip);
        const failed = yield* tasks.updateAttempt(AttemptId.make("a1"), {
          state: "failed",
          outcome: "Timed out",
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

    expect(tags(result.first.entries)).toEqual(["TaskStateChanged", "CheckpointRecorded"]);
    expect(result.first.value.task).toMatchObject({ state: "active", currentAttemptId: "a1" });
    expect(result.twice).toMatchObject({ _tag: "TaskRefused", reason: "attempt-live" });
    expect(result.running.value.attempt).toMatchObject({ state: "running", sessionId: "s1" });
    expect(result.stale).toMatchObject({ _tag: "StaleTask", taskId: "copy" });
    expect(tags(result.moved.entries)).toEqual(["TaskStateChanged", "CheckpointRecorded"]);
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

  // covers EX-001, OR-006
  it("[TC-OR-004] completes a Task only with its own Attempt, a finished subtree and no open questions, and its Quest with it", async () => {
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
            return yield* tasks.completeTask(task.id, started.value.task.revision, {
              summary: `${id} done`,
              attemptId: AttemptId.make(attemptId),
              artifacts: [{ id: ArtifactId.make(`art-${id}`), kind: "text", label: id, value: `${id} text` }],
              at,
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
        const done = yield* tasks.completeTask(campaignId, current.revision, completion("a-root"));
        return {
          otherAttempt,
          childrenOpen,
          ask,
          questionsOpen,
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
    expect(tags(result.done.entries)).toEqual(["TaskCompleted", "CheckpointRecorded", "QuestCompleted"]);
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
    expect(tags(result.asked.entries)).toEqual(["QuestionAsked"]);
    expect(result.asked.entries[0]?.correlation).toEqual({ agentId: PIP, threadId, messageId: null });
    expect(result.wrong).toMatchObject({ _tag: "TaskRefused", reason: "not-recipient" });
    expect(result.up.value).toMatchObject({ recipientId: ALDRIC, chain: [ADA] });
    expect(tags(result.up.entries)).toEqual(["QuestionEscalated"]);
    expect(result.top.value).toMatchObject({ recipientId: null, chain: [ADA, ALDRIC] });
    expect(result.byLead).toMatchObject({ _tag: "TaskRefused", reason: "not-recipient" });
    expect(result.answered.value).toMatchObject({ state: "answered", answer: "EU", answeredBy: { _tag: "User" } });
    expect(tags(result.answered.entries)).toEqual(["QuestionAnswered"]);
    expect(result.again).toMatchObject({ _tag: "TaskRefused", reason: "question-answered" });
    // The lead of the top Task has no lead above it: its question comes straight to you.
    expect(result.topAsk.value.recipientId).toBeNull();
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

    expect(tags(result.reached.entries)).toEqual(["CheckpointRecorded"]);
    expect(result.reached.entries[0]?.payload).toMatchObject({
      checkpoint: { source: "planned", kind: "milestone", milestoneId: "m-draft" },
      milestone: { id: "m-draft", reachedAt: later },
    });
    expect(result.twice).toMatchObject({ _tag: "TaskRefused", reason: "milestone-mismatch" });
    expect(result.wrongSource).toMatchObject({ _tag: "TaskRefused", reason: "checkpoint-kind" });
    expect(result.finding.value).toMatchObject({ source: "unplanned", kind: "finding", attemptId: null });
    expect(tags(result.handed.entries)).toEqual(["HandedOff"]);
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
        yield* tasks.updateAttempt(AttemptId.make("a1"), { state: "failed", outcome: "Lost", at: now });
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
        yield* tasks.updateAttempt(AttemptId.make("a-root"), { state: "completed", at: now });
        const failOpen = yield* reason(tasks.moveTask(campaignId, (yield* latest("campaign")).revision, "failed", now));
        // Ada's Task waits on Quill's copy before it can complete.
        const build = yield* latest("build");
        const buildStarted = yield* tasks.startAttempt(build.id, build.revision, attempt("a-build"));
        const waiting = yield* reason(
          tasks.completeTask(build.id, buildStarted.value.task.revision, {
            summary: "Built",
            attemptId: AttemptId.make("a-build"),
            artifacts: [],
            at: now,
          }),
        );
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
        const call = { agentId: ALDRIC, key: "k1", tool: "plan_steps" as const, input: '{"steps":[]}', at: now };
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
});
