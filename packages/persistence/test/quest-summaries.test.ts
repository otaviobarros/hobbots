import { ApprovalRepository, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  ApprovalRequest,
  ArtifactId,
  AttemptId,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  type EventEnvelope,
  QuestId,
  QuestionId,
  type QuestSummary,
  questSummaryOf,
  sameSummary,
  type Task,
  TaskId,
  type TaskTarget,
  type TaskTree,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/sql";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  migrations,
  TaskRepositoryLive,
} from "../src/index.ts";
import questSummaries from "../src/migrations/0102_quest_summaries.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #1373 (ADR 037): the hub's QuestSummary. Every change that touches a Task tree folds the
// summary of each Quest in it in its own transaction, and journals QuestSummaryChanged only when the
// summary says something new. The sync snapshot serves what was last journaled. On SQLite and
// PostgreSQL alike.

const layer = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  ApprovalRepositoryLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));

const NOW = "2026-11-12T10:00:00.000Z";
const HOBS = ["aldric", "quill", "ada", "pip"].map((id) => AgentId.make(id));
const [ALDRIC = AgentId.make("aldric")] = HOBS;

const hob = (id: AgentId) =>
  new Agent({
    id,
    name: id,
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

let clock = 0;
/** A time later than every one before it, so oldest first is the order things were made in. */
const tick = () => new Date(Date.parse(NOW) + 1000 * ++clock).toISOString();

const approval = (id: string, task: Task) =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId: task.ownerId,
    threadId: task.threadId ?? ThreadId.make("none"),
    messageId: null,
    taskId: task.id,
    rootTaskId: task.rootId,
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
    createdAt: tick(),
    decidedAt: null,
  });

const TARGETS: ReadonlyArray<TaskTarget> = ["waiting", "blocked", "active", "failed", "cancelling", "cancelled"];

type Op =
  | { readonly _tag: "Delegate"; readonly parent: number; readonly member: number }
  | { readonly _tag: "Step"; readonly parent: number }
  | { readonly _tag: "Lead"; readonly task: number }
  | { readonly _tag: "Start"; readonly task: number }
  | { readonly _tag: "End"; readonly task: number; readonly failed: boolean }
  | { readonly _tag: "Move"; readonly task: number; readonly to: TaskTarget }
  | { readonly _tag: "Complete"; readonly task: number; readonly pr: number | null }
  | { readonly _tag: "Retry"; readonly task: number }
  | { readonly _tag: "Ask"; readonly task: number }
  | { readonly _tag: "Escalate"; readonly question: number }
  | { readonly _tag: "Answer"; readonly question: number }
  | { readonly _tag: "Request"; readonly task: number }
  | { readonly _tag: "Decide"; readonly approval: number };

const pick = fc.nat(12);
const ops: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ _tag: fc.constant("Delegate" as const), parent: pick, member: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ _tag: fc.constant("Step" as const), parent: pick }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("Lead" as const), task: pick }) },
  { weight: 3, arbitrary: fc.record({ _tag: fc.constant("Start" as const), task: pick }) },
  { weight: 2, arbitrary: fc.record({ _tag: fc.constant("End" as const), task: pick, failed: fc.boolean() }) },
  {
    weight: 3,
    arbitrary: fc.record({ _tag: fc.constant("Move" as const), task: pick, to: fc.constantFrom(...TARGETS) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ _tag: fc.constant("Complete" as const), task: pick, pr: fc.option(fc.nat(2)) }),
  },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("Retry" as const), task: pick }) },
  { weight: 2, arbitrary: fc.record({ _tag: fc.constant("Ask" as const), task: pick }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("Escalate" as const), question: pick }) },
  { weight: 2, arbitrary: fc.record({ _tag: fc.constant("Answer" as const), question: pick }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("Request" as const), task: pick }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("Decide" as const), approval: pick }) },
);

const at = <A>(list: ReadonlyArray<A>, index: number): A | undefined =>
  list.length === 0 ? undefined : list[index % list.length];

/**
 * The Task a pick names: 0 the top Task, any other a Task under it, so the script rarely ends the
 * whole Quest before its party has done anything.
 */
const taskAt = (tree: TaskTree, index: number): Task | undefined => {
  const under = tree.tasks.slice(1);
  return index === 0 || under.length === 0 ? tree.tasks[0] : at(under, index);
};

/** What a step reads: the tree as it stands, and the id its new records take. */
interface StepContext {
  readonly tree: TaskTree;
  readonly id: string;
}

type Hub = TaskRepository | ApprovalRepository;
type Step<K extends Op["_tag"]> = (
  op: Extract<Op, { readonly _tag: K }>,
  context: StepContext,
) => Effect.Effect<unknown, unknown, Hub>;

const newTask = (id: string, ownerId: AgentId, parentId: TaskId) => ({
  id: TaskId.make(id),
  ownerId,
  parentId,
  threadId: null,
  brief: `Brief ${id}`,
  dependsOn: [],
  createdAt: tick(),
});

const delegation = (id: string) => ({
  id: DelegationId.make(`d-${id}`),
  brief: `Delegated ${id}`,
  expectedOutput: null,
  authority: { overrides: {}, folders: null },
  timeoutMs: null,
});

/** Runs `then` on the Task a pick names, or does nothing when the tree has none. */
const onTask = (tree: TaskTree, index: number, then: (task: Task) => Effect.Effect<unknown, unknown, Hub>) => {
  const task = taskAt(tree, index);
  return task === undefined ? Effect.void : then(task);
};

const NOTHING = Effect.void;

/** What each step of the script does to the hub, through its repositories; a refusal writes nothing. */
const STEPS: { readonly [K in Op["_tag"]]: Step<K> } = {
  Delegate: (op, { tree, id }) => {
    const led = tree.tasks.filter((task) => tree.quests.some((quest) => quest.taskId === task.id));
    const parent = at(led, op.parent);
    const member = at(HOBS, op.member);
    if (parent === undefined || member === undefined) return NOTHING;
    const task = newTask(id, member, parent.id);
    return TaskRepository.use((tasks) => tasks.createTask({ task, delegation: delegation(id), milestones: [] }));
  },
  Step: (op, { tree, id }) => {
    const parent = at(tree.tasks, op.parent);
    if (parent === undefined) return NOTHING;
    const task = newTask(id, parent.ownerId, parent.id);
    return TaskRepository.use((tasks) => tasks.createTask({ task, delegation: null, milestones: [] }));
  },
  Lead: (op, { tree, id }) =>
    onTask(tree, op.task, (task) =>
      TaskRepository.use((tasks) =>
        tasks.startQuest({
          id: QuestId.make(`q-${id}`),
          taskId: task.id,
          goal: `Goal ${id}`,
          acceptance: [],
          limits: DEFAULT_QUEST_LIMITS,
          createdAt: tick(),
        }),
      ),
    ),
  Start: (op, { tree, id }) =>
    onTask(tree, op.task, (task) =>
      TaskRepository.use((tasks) =>
        tasks.startAttempt(task.id, task.revision, {
          id: AttemptId.make(`a-${id}`),
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: tick(),
        }),
      ),
    ),
  End: (op, { tree }) =>
    onTask(tree, op.task, (task) => {
      const attemptId = task.currentAttemptId;
      if (attemptId === null) return NOTHING;
      const end = op.failed
        ? ({ _tag: "Failed", reason: "Timed out" } as const)
        : ({ _tag: "Finished", outcome: null } as const);
      return TaskRepository.use((tasks) => tasks.updateAttempt(attemptId, { _tag: "Ended", end, at: tick() }));
    }),
  Move: (op, { tree }) =>
    onTask(tree, op.task, (task) =>
      TaskRepository.use((tasks) => tasks.moveTask(task.id, task.revision, op.to, tick())),
    ),
  Complete: (op, { tree, id }) =>
    onTask(tree, op.task, (task) =>
      Effect.gen(function* () {
        const attemptId = task.currentAttemptId;
        if (attemptId === null) return;
        const tasks = yield* TaskRepository;
        const ledger = yield* tasks.readLedger(task.id);
        const pr = op.pr;
        const artifacts =
          pr === null
            ? []
            : [
                {
                  id: ArtifactId.make(`art-${id}`),
                  kind: "link" as const,
                  label: "PR",
                  value: `https://github.com/acme/shop/pull/${pr}`,
                },
              ];
        yield* tasks.completeTask(task.id, task.revision, {
          summary: "Done",
          attemptId,
          artifacts,
          at: tick(),
          carried: Option.isSome(ledger) ? carriedFrom(ledger.value, () => true) : [],
        });
      }),
    ),
  Retry: (op, { tree }) =>
    onTask(tree, op.task, (task) => TaskRepository.use((tasks) => tasks.retryTask(task.id, task.revision, tick()))),
  Ask: (op, { tree, id }) =>
    onTask(tree, op.task, (task) =>
      TaskRepository.use((tasks) =>
        tasks.askQuestion({
          id: QuestionId.make(`question-${id}`),
          taskId: task.id,
          askerId: task.ownerId,
          text: "Which way?",
          createdAt: tick(),
        }),
      ),
    ),
  Escalate: (op, { tree }) => {
    const question = at(tree.questions, op.question);
    const by = question?.recipientId ?? null;
    if (question === undefined || by === null) return NOTHING;
    return TaskRepository.use((tasks) => tasks.escalateQuestion(question.id, by));
  },
  Answer: (op, { tree }) => {
    const question = at(tree.questions, op.question);
    if (question === undefined) return NOTHING;
    const by =
      question.recipientId === null
        ? ({ _tag: "User" } as const)
        : ({ _tag: "Lead", agentId: question.recipientId } as const);
    return TaskRepository.use((tasks) => tasks.answerQuestion(question.id, by, "That way", tick()));
  },
  Request: (op, { tree, id }) =>
    onTask(tree, op.task, (task) =>
      ApprovalRepository.use((approvals) => approvals.insert(approval(`approval-${id}`, task))),
    ),
  Decide: (op, { tree }) => {
    const pending = at(tree.approvals, op.approval);
    if (pending === undefined) return NOTHING;
    const decided = new ApprovalRequest({ ...pending, state: "approved", decidedAt: tick() });
    return ApprovalRepository.use((approvals) => approvals.resolve(decided, "pending"));
  },
};

const perform = (op: Op, tree: TaskTree, prefix: string, step: number) =>
  (STEPS[op._tag] as Step<Op["_tag"]>)(op, { tree, id: `${prefix}-${step}` });

const summariesIn = (entries: ReadonlyArray<EventEnvelope>): ReadonlyArray<[EventEnvelope, QuestSummary]> =>
  entries.flatMap((entry) =>
    entry.payload._tag === "QuestSummaryChanged"
      ? [[entry, entry.payload.summary] as [EventEnvelope, QuestSummary]]
      : [],
  );

describe("Quest summaries", () => {
  let hub: ManagedRuntime.ManagedRuntime<Layer.Success<typeof layer>, Layer.Error<typeof layer>>;
  beforeAll(async () => {
    hub = ManagedRuntime.make(layer);
    await hub.runPromise(
      HobbotsRepository.use((repo) => Effect.forEach(HOBS, (id) => repo.insertAgent(hob(id)), { discard: true })),
    );
  });
  afterAll(() => hub.dispose());

  /** A request of yours in a new chat, whose Task Aldric leads as a Quest. */
  const quest = (run: string) =>
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const tasks = yield* TaskRepository;
      const threadId = ThreadId.make(`chat-${run}`);
      yield* repo.upsertThread(
        new Thread({ id: threadId, agentId: ALDRIC, title: run, createdAt: NOW, updatedAt: NOW }),
      );
      const top = TaskId.make(`top-${run}`);
      yield* tasks.createTask({
        task: { id: top, ownerId: ALDRIC, parentId: null, threadId, brief: "Launch", dependsOn: [], createdAt: tick() },
        delegation: null,
        milestones: [],
      });
      const started = yield* tasks.startQuest({
        id: QuestId.make(`q-${run}`),
        taskId: top,
        goal: "Launch the shop",
        acceptance: [],
        limits: DEFAULT_QUEST_LIMITS,
        createdAt: tick(),
      });
      return { threadId, top, started };
    });

  // covers ADR 037 (Quests in camps), STD-ARCH-015, STD-ARCH-016
  it("[TC-OR-1373-01] journals each Quest's summary in the change's transaction, only when it changes, and always as a fold of its tree", async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(ops, { minLength: 8, maxLength: 40 }), (script) =>
        hub.runPromise(
          Effect.gen(function* () {
            runs += 1;
            const run = `r${runs}`;
            const tasks = yield* TaskRepository;
            const journal = yield* EventJournal;
            const { threadId, top, started } = yield* quest(run);
            // A new Quest's summary is journaled with it.
            const published = new Map(summariesIn(started.entries).map(([, summary]) => [summary.questId, summary]));
            expect([...published.keys()]).toEqual([started.value.id]);
            let tree = Option.getOrThrow(yield* tasks.readTree(top));
            let folds = new Map(tree.quests.map((each) => [each.id, questSummaryOf(each, tree)]));
            for (const [step, op] of script.entries()) {
              const where = `step ${step} (${JSON.stringify(op)}) of ${JSON.stringify(script)}`;
              const head = yield* journal.head;
              const outcome = yield* Effect.exit(perform(op, tree, run, step));
              // A refusal is a typed failure, never a defect.
              if (Exit.isFailure(outcome)) {
                expect(
                  outcome.cause.reasons.every((reason) => reason._tag === "Fail"),
                  where,
                ).toBe(true);
              }
              const entries = yield* journal.readAfter(head.sequence);
              if (Exit.isFailure(outcome)) expect(entries, where).toEqual([]);
              const changed = summariesIn(entries);
              // Every summary follows the change that caused it, in the same batch of entries.
              if (changed.length > 0) expect(entries[0]?.type, where).not.toBe("QuestSummaryChanged");
              for (const [entry, summary] of changed) {
                expect(summary.revision, where).toBe(entry.sequence);
                published.set(summary.questId, summary);
              }
              tree = Option.getOrThrow(yield* tasks.readTree(top));
              const next = new Map(tree.quests.map((each) => [each.id, questSummaryOf(each, tree)]));
              for (const [questId, fold] of next) {
                const before = folds.get(questId);
                const journaledNow = changed.some(([, summary]) => summary.questId === questId);
                // Journaled exactly when the fold says something new.
                expect(journaledNow, `${where}: ${questId}`).toBe(before === undefined || !sameSummary(before, fold));
                const last = published.get(questId);
                expect(last !== undefined && sameSummary(last, fold), `${where}: ${questId}`).toBe(true);
              }
              expect(changed.length, where).toBe(
                [...next].filter(([questId, fold]) => {
                  const before = folds.get(questId);
                  return before === undefined || !sameSummary(before, fold);
                }).length,
              );
              folds = next;
              // The sync snapshot serves what was last journaled for each of the chat's Quests.
              const snapshot = yield* tasks.listQuestSummaries(threadId);
              expect(new Map(snapshot.map((summary) => [summary.questId, summary])), where).toEqual(published);
            }
          }),
        ),
      ),
      { numRuns: 40 },
    );
    // Up to 1,600 changes, each read back several ways: well past the default on PostgreSQL.
  }, 120_000);

  // covers ADR 037 (Quests in camps), STD-ARCH-014
  it("[TC-OR-1373-02] writes a summary only with the change that caused it: a change rolled back leaves the summary as it was", async () => {
    const result = await hub.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskRepository;
        const journal = yield* EventJournal;
        const { threadId, top } = yield* quest("rollback");
        const before = yield* tasks.listQuestSummaries(threadId);
        const head = yield* journal.head;
        // A member joins and the transaction around it fails before it commits.
        const failed = yield* Effect.exit(
          Effect.gen(function* () {
            yield* tasks.createTask({
              task: {
                id: TaskId.make("rollback-member"),
                ownerId: HOBS[1] ?? ALDRIC,
                parentId: top,
                threadId: null,
                brief: "Write copy",
                dependsOn: [],
                createdAt: tick(),
              },
              delegation: {
                id: DelegationId.make("d-rollback"),
                brief: "Write copy",
                expectedOutput: null,
                authority: { overrides: {}, folders: null },
                timeoutMs: null,
              },
              milestones: [],
            });
            return yield* Effect.fail("crashed midway" as const);
          }).pipe(sql.withTransaction),
        );
        const tree = Option.getOrThrow(yield* tasks.readTree(top));
        return {
          failed,
          before,
          after: yield* tasks.listQuestSummaries(threadId),
          tasks: tree.tasks.map((task) => task.id),
          entries: yield* journal.readAfter(head.sequence),
          active: (yield* tasks.listQuestSummaries(null)).some((summary) => summary.questId === "q-rollback"),
        };
      }),
    );
    expect(Exit.isFailure(result.failed)).toBe(true);
    expect(result.tasks).toEqual(["top-rollback"]);
    expect(result.after).toEqual(result.before);
    expect(result.after[0]?.tones).toEqual({ needs: 0, working: 0, waiting: 0, done: 0, problem: 0, idle: 0 });
    expect(result.entries).toEqual([]);
    // Without a chat, the snapshot lists every Quest still active.
    expect(result.active).toBe(true);
  });

  // covers ADR 037 (Quests in camps), DP-003
  it("[TC-DP-1373-03] gives every Quest stored before it its summary, folded from its tree, and journals nothing", async () => {
    const result = await hub.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskRepository;
        const journal = yield* EventJournal;
        const { threadId, top } = yield* quest("before");
        yield* tasks.createTask({
          task: {
            id: TaskId.make("before-step"),
            ownerId: ALDRIC,
            parentId: top,
            threadId: null,
            brief: "Plan",
            dependsOn: [],
            createdAt: tick(),
          },
          delegation: null,
          milestones: [],
        });
        const published = yield* tasks.listQuestSummaries(threadId);
        // As a hub from before the migration: no summaries at all.
        yield* sql`DROP TABLE quest_summaries`;
        const head = yield* journal.head;
        yield* questSummaries;
        const tree = Option.getOrThrow(yield* tasks.readTree(top));
        return {
          published,
          head,
          migrated: yield* tasks.listQuestSummaries(threadId),
          fold: tree.quests.map((each) => questSummaryOf(each, tree)),
          entries: yield* journal.readAfter(head.sequence),
          known: Object.keys(migrations).includes("0102_quest_summaries"),
        };
      }),
    );
    expect(result.known).toBe(true);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated.every((summary, index) => sameSummary(summary, result.fold[index] ?? summary))).toBe(true);
    expect(result.migrated.map(({ revision, ...rest }) => rest)).toEqual(
      result.published.map(({ revision, ...rest }) => rest),
    );
    expect(result.migrated[0]?.tones.idle).toBe(1);
    // Stored at the journal's head, with nothing journaled: nothing changed.
    expect(result.migrated[0]?.revision).toBe(result.head.sequence);
    expect(result.entries).toEqual([]);
  });
});
