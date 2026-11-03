import { HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  CANCELLED_ATTEMPT,
  type Committed,
  carriedFrom,
  MilestoneId,
  type TaskId,
  TaskId as TaskIdSchema,
  Thread,
  ThreadId,
  type TurnRunner,
} from "@hobbots/domain";
import { endTurn } from "@hobbots/orchestration";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

// Issues #669 and #674: a member's or step's turn that ended once its Task's cancel was asked for
// recorded its Attempt as completed. Every runner now ends its turn by the one turn-end decision,
// and the record ends the Attempt from its Task as it is then, in the same transaction.

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | EventJournal>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-03T00:00:00.000Z";
const later = "2026-11-03T00:05:00.000Z";
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("first-run");
const top = TaskIdSchema.make("review");
const work = TaskIdSchema.make("commit");
const attemptId = AttemptId.make("a-commit");

/** A change the records may refuse, kept or dropped as the runners do. */
const deps = Effect.map(TaskRepository, (tasks) => ({
  tasks,
  attempt: <A, E>(change: Effect.Effect<Committed<A>, E>) =>
    change.pipe(
      Effect.map((committed) => committed.value),
      Effect.option,
    ),
  explain: () => Effect.void,
}));

/** Pip's Task with one Task under it, whose turn runs as `a-commit`, kept open by `milestones`. */
const turnRunning = (milestones: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(
      new Agent({
        id: PIP,
        name: "Pip",
        roleTitle: "Engineer",
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
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: PIP, title: "First run", createdAt: now, updatedAt: now }),
    );
    const tasks = yield* TaskRepository;
    const task = (id: TaskId, parentId: TaskId | null, milestones: ReadonlyArray<string>) =>
      tasks.createTask({
        task: { id, ownerId: PIP, parentId, threadId, brief: `Brief for ${id}`, dependsOn: [], createdAt: now },
        delegation: null,
        milestones: milestones.map((title) => ({ id: MilestoneId.make(`${id}-${title}`), title })),
      });
    yield* task(top, null, []);
    const created = yield* task(work, top, milestones);
    yield* tasks.startAttempt(work, created.value.revision, {
      id: attemptId,
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: now,
    });
    yield* tasks.updateAttempt(attemptId, { _tag: "Running", sessionId: "s1", at: now });
  });

/** Asks to cancel the Task the turn works on, as Cancel Task does. */
const cancel = Effect.gen(function* () {
  const tasks = yield* TaskRepository;
  const [task] = Option.getOrThrow(yield* tasks.readTree(work)).tasks;
  if (task === undefined) throw new Error("no Task");
  yield* tasks.moveTask(work, task.revision, "cancelling", later);
});

const endsWith = (runner: TurnRunner) =>
  Effect.gen(function* () {
    // The turn carries the Task's own backpack item, as its runner's turn does.
    const ledger = Option.getOrThrow(yield* TaskRepository.use((tasks) => tasks.readLedger(work)));
    yield* endTurn(yield* deps, {
      runner,
      taskId: work,
      attemptId,
      ending: { _tag: "Replied", text: "Committed it" },
      carried: carriedFrom(ledger, () => true),
      at: later,
    });
    const tree = Option.getOrThrow(yield* TaskRepository.use((tasks) => tasks.readTree(work)));
    return {
      task: tree.tasks[0]?.state,
      attempts: tree.attempts.map(({ number, state, outcome }) => ({ number, state, outcome })),
    };
  });

describe("ending a turn under a cancel", () => {
  // covers EX-001, OR-006
  it("[TC-OR-458] a member's or step's turn that ends after its Task's cancel was asked records a cancelled Attempt, and one that ended first keeps completed", async () => {
    for (const runner of ["member", "step"] as const) {
      // The cancel arrives while the turn runs; the turn then ends with its reply.
      const underCancel = await run(Effect.andThen(Effect.andThen(turnRunning(), cancel), endsWith(runner)));
      expect([runner, underCancel]).toEqual([
        runner,
        { task: "cancelled", attempts: [{ number: 1, state: "cancelled", outcome: CANCELLED_ATTEMPT }] },
      ]);
    }

    // A member's turn that ended before the cancel keeps its own end; its Task, blocked on its milestone, is then cancelled.
    const memberFirst = await run(
      Effect.gen(function* () {
        yield* turnRunning(["Committed"]);
        const ended = yield* endsWith("member");
        yield* cancel;
        const tree = Option.getOrThrow(yield* TaskRepository.use((tasks) => tasks.readTree(work)));
        return { ended, attempts: tree.attempts.map(({ state }) => state), task: tree.tasks[0]?.state };
      }),
    );
    expect(memberFirst).toEqual({
      ended: { task: "blocked", attempts: [{ number: 1, state: "completed", outcome: "The turn finished." }] },
      attempts: ["completed"],
      task: "cancelling",
    });

    // A step whose session finished first completed with its reply, and there is nothing to cancel.
    const stepFirst = await run(Effect.andThen(turnRunning(), endsWith("step")));
    expect(stepFirst).toEqual({
      task: "completed",
      attempts: [{ number: 1, state: "completed", outcome: "The step's session finished." }],
    });
  });
});
