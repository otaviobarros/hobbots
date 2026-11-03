import { type AttemptResume, HobbotsRepository, type NewAttempt, TaskRepository } from "@hobbots/agents";
import { Agent, AgentId, AttemptId, TaskId, Thread, ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// A lead's later chat turns on its Task go on in the Task's current Attempt (#577): only a retry or
// a reassignment starts a new one.

const TestLayer = Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const run = <A, E>(effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | EventJournal>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-03T00:00:00.000Z";
const later = "2026-11-03T00:05:00.000Z";
const ALDRIC = AgentId.make("aldric");
const threadId = ThreadId.make("t1");
const top = TaskId.make("campaign");

const attempt = (id: string): NewAttempt => ({
  id: AttemptId.make(id),
  runtime: "claude-code",
  sessionId: null,
  configVersion: 1,
  policyVersion: null,
  startedAt: now,
});
const resume: AttemptResume = { runtime: "claude-code", configVersion: 1, at: later };

/** Aldric's Task in his thread, with its first turn's Attempt ended as `ended`. */
const turnEnded = (ended: "completed" | "interrupted" | "cancelled" | "unresolved" = "completed") =>
  Effect.gen(function* () {
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
        createdAt: now,
      }),
    );
    yield* repo.upsertThread(
      new Thread({ id: threadId, agentId: ALDRIC, title: "Campaign", createdAt: now, updatedAt: now }),
    );
    const tasks = yield* TaskRepository;
    const created = yield* tasks.createTask({
      task: {
        id: top,
        ownerId: ALDRIC,
        parentId: null,
        threadId,
        brief: "Plan the campaign",
        dependsOn: [],
        createdAt: now,
      },
      delegation: null,
      milestones: [],
    });
    yield* tasks.startAttempt(top, created.value.revision, attempt("a1"));
    yield* tasks.updateAttempt(AttemptId.make("a1"), { state: "running", sessionId: "s1", at: now });
    return (yield* tasks.updateAttempt(AttemptId.make("a1"), { state: ended, at: now })).value.task;
  });

const attemptsOf = Effect.map(
  TaskRepository.use((tasks) => tasks.readTree(top)),
  (tree) => Option.getOrThrow(tree).attempts.map(({ id, number, state, endedAt }) => ({ id, number, state, endedAt })),
);

describe("resuming a Task's Attempt", () => {
  // covers EX-001, OR-006
  it("[TC-OR-310] a later turn resumes the Task's ended Attempt, which keeps its number and session, and ends again with the turn", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const task = yield* turnEnded();
        const resumed = yield* tasks.resumeAttempt(top, task.revision, resume);
        const live = yield* attemptsOf;
        const ended = yield* tasks.updateAttempt(AttemptId.make("a1"), { state: "completed", at: later });
        const again = yield* tasks.resumeAttempt(top, ended.value.task.revision, resume);
        return { resumed, live, again, after: yield* attemptsOf };
      }),
    );
    expect(result.resumed.value.task).toMatchObject({ state: "active", currentAttemptId: "a1" });
    expect(result.resumed.value.attempt).toMatchObject({ id: "a1", number: 1, state: "starting", sessionId: "s1" });
    expect(result.resumed.value.attempt.startedAt).toBe(now);
    expect(result.resumed.entries.map((entry) => entry.payload._tag)).toEqual([
      "TaskStateChanged",
      "CheckpointRecorded",
    ]);
    expect(result.live).toEqual([{ id: "a1", number: 1, state: "starting", endedAt: null }]);
    expect(result.again.value.attempt).toMatchObject({ id: "a1", number: 1 });
    expect(result.after).toEqual([{ id: "a1", number: 1, state: "starting", endedAt: null }]);
  });

  // covers EX-001, EX-002, OR-006
  it("[TC-OR-311] refuses to resume a live, cancelled or unconfirmed Attempt, one on another brain, or a Task that ended or is cancelling, and writes nothing", async () => {
    const refusal = (ended: "completed" | "cancelled" | "unresolved", change: Partial<typeof resume> = {}) =>
      run(
        Effect.gen(function* () {
          const tasks = yield* TaskRepository;
          const journal = yield* EventJournal;
          const task = yield* turnEnded(ended);
          const head = yield* journal.head;
          const refused = yield* tasks.resumeAttempt(top, task.revision, { ...resume, ...change }).pipe(Effect.flip);
          return { refused, unchanged: JSON.stringify(yield* journal.head) === JSON.stringify(head) };
        }),
      );
    expect(await refusal("cancelled")).toMatchObject({ refused: { reason: "attempt-ended" }, unchanged: true });
    expect(await refusal("unresolved")).toMatchObject({ refused: { reason: "attempt-ended" }, unchanged: true });
    expect(await refusal("completed", { runtime: "codex" })).toMatchObject({
      refused: { reason: "attempt-mismatch" },
      unchanged: true,
    });
    expect(await refusal("completed", { configVersion: 2 })).toMatchObject({
      refused: { reason: "attempt-mismatch" },
      unchanged: true,
    });

    const live = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const task = yield* turnEnded();
        const resumed = yield* tasks.resumeAttempt(top, task.revision, resume);
        return yield* tasks.resumeAttempt(top, resumed.value.task.revision, resume).pipe(Effect.flip);
      }),
    );
    expect(live).toMatchObject({ reason: "attempt-live" });

    const ending = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const task = yield* turnEnded();
        const cancelling = yield* tasks.moveTask(top, task.revision, "cancelling", later);
        const whileCancelling = yield* tasks.resumeAttempt(top, cancelling.value.revision, resume).pipe(Effect.flip);
        const cancelled = yield* tasks.moveTask(top, cancelling.value.revision, "cancelled", later);
        const afterEnd = yield* tasks.resumeAttempt(top, cancelled.value.revision, resume).pipe(Effect.flip);
        const stale = yield* tasks.resumeAttempt(top, task.revision, resume).pipe(Effect.flip);
        return { whileCancelling, afterEnd, stale, attempts: yield* attemptsOf };
      }),
    );
    expect(ending.whileCancelling).toMatchObject({ _tag: "IllegalTaskTransition" });
    expect(ending.afterEnd).toMatchObject({ reason: "task-ended" });
    expect(ending.stale).toMatchObject({ _tag: "StaleTask" });
    expect(ending.attempts).toEqual([{ id: "a1", number: 1, state: "completed", endedAt: now }]);
    // About 3 seconds on PostgreSQL alone, so the 5 second default runs out on a loaded runner.
  }, 20_000);
});
