import { ActivityRepository, type FileChangeDraft, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  ContentId,
  FileChangeId,
  type FileVersion,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ActivityRepositoryLive, EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// A lead's later chat turns resume the Task's Attempt (#577), so one Attempt holds several turns'
// Workbench records: a later turn takes back only the changes it recorded itself.

const TestLayer = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  ActivityRepositoryLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const run = <A, E>(
  effect: Effect.Effect<A, E, HobbotsRepository | TaskRepository | ActivityRepository | EventJournal>,
) => effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const now = "2026-11-02T00:00:00.000Z";
const later = "2026-11-02T00:00:05.000Z";
const nextTurn = "2026-11-02T00:01:00.000Z";
const afterNext = "2026-11-02T00:01:05.000Z";
const ALDRIC = AgentId.make("aldric");
const threadId = ThreadId.make("t1");
const taskId = TaskId.make("tidy");
const attemptId = AttemptId.make("a1");
const project = "/work/project";
const contents = (n: number) => ContentId.make(String(n).repeat(64).slice(0, 64));

/** Aldric's Task with one running Attempt. */
const seed = Effect.gen(function* () {
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
    new Thread({ id: threadId, agentId: ALDRIC, title: "Docs", createdAt: now, updatedAt: now }),
  );
  const tasks = yield* TaskRepository;
  const created = yield* tasks.createTask({
    task: {
      id: taskId,
      ownerId: ALDRIC,
      parentId: null,
      threadId,
      brief: "Tidy the docs",
      dependsOn: [],
      createdAt: now,
    },
    delegation: null,
    milestones: [],
  });
  return yield* tasks.startAttempt(taskId, created.value.revision, {
    id: attemptId,
    runtime: "claude-code",
    sessionId: null,
    configVersion: 1,
    policyVersion: null,
    startedAt: now,
  });
});

const version = (hash: string, contentId: ContentId | null): FileVersion => ({
  hash,
  size: 12,
  kind: "text",
  contentId,
  notKept: contentId === null ? "secret" : null,
});

const change = (path: string, settled: boolean, after = version("h2", contents(3))): FileChangeDraft => ({
  id: FileChangeId.make(`change-${path}`),
  path,
  kind: "edited",
  movedFrom: null,
  before: version("h1", contents(2)),
  after,
  sharedWith: [],
  settled,
  recordedAt: later,
});

describe("Workbench records across the turns of one Attempt", () => {
  // covers UX-002, EX-001
  it("[TC-OR-312] a later turn's changes leave the earlier turn's in place, replace one at the same path, and take back only its own", async () => {
    const { second, third, activity } = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* ActivityRepository;
        // The first turn edits a.md and b.md.
        yield* repo.saveChanges(attemptId, project, [change("a.md", true), change("b.md", true)], now);
        // The next turn, in the same Attempt, edits b.md again and adds c.md...
        const turn = (path: string, hash: string) => ({
          ...change(path, false, version(hash, contents(5))),
          id: FileChangeId.make(`next-${path}`),
          recordedAt: afterNext,
        });
        const second = Option.getOrThrow(
          yield* repo.saveChanges(attemptId, project, [turn("b.md", "h4"), turn("c.md", "h5")], nextTurn),
        );
        // ...then puts c.md back, so its last scan finds only b.md.
        const third = Option.getOrThrow(yield* repo.saveChanges(attemptId, project, [turn("b.md", "h4")], nextTurn));
        return { second, third, activity: Option.getOrThrow(yield* repo.read(attemptId)) };
      }),
    );
    expect(second.value.removed).toEqual([]);
    expect(third.value.removed).toEqual([FileChangeId.make("next-c.md")]);
    expect(activity.changes.map(({ path, after }) => [path, after?.hash])).toEqual([
      ["a.md", "h2"],
      ["b.md", "h4"],
    ]);
  });
});
