import { ActivityRepository, type FileChangeDraft, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  CommandId,
  ContentId,
  FileChangeId,
  type FileVersion,
  FolderScanId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ActivityRepositoryLive, EventJournal, HobbotsRepositoryLive, TaskRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// The Workbench's records of ADR 023 on SQLite and PostgreSQL: each names its Attempt, takes its
// Task from it, commits with its journal event, and loses its heavy details past retention.

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

const command = (state: "running" | "succeeded") => ({
  id: CommandId.make("c1"),
  attemptId,
  stepId: "tool-1",
  command: "npm run format",
  folder: project,
  sandboxed: true,
  liveOutput: false,
  state,
  exitCode: state === "running" ? null : 0,
  startedAt: now,
  endedAt: state === "running" ? null : later,
  output: state === "running" ? null : { head: "formatted\n", tail: "", omittedBytes: 0, totalBytes: 10, logged: true },
  log: state === "running" ? null : { contentId: contents(1), totalBytes: 20_000, omittedBytes: 0 },
  logNotKept: null,
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

describe("Workbench records", () => {
  // covers UX-002
  it("[TC-IN-173] keeps a command from its start to its end, with its Task taken from its Attempt, and journals each write", async () => {
    const { started, ended, entries, activity } = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* ActivityRepository;
        const started = Option.getOrThrow(yield* repo.saveCommand(command("running")));
        const ended = Option.getOrThrow(yield* repo.saveCommand(command("succeeded")));
        const journal = yield* EventJournal;
        const entries = yield* journal.readAfter(started.entries[0]?.sequence ?? 0);
        return { started, ended, entries, activity: Option.getOrThrow(yield* repo.read(attemptId)) };
      }),
    );
    expect(started.value.taskId).toBe(taskId);
    expect(started.value.state).toBe("running");
    expect(ended.value).toMatchObject({ id: "c1", state: "succeeded", exitCode: 0, log: { contentId: contents(1) } });
    expect(entries.map((entry) => entry.type)).toEqual(["CommandRecorded"]);
    expect(entries[0]?.correlation.agentId).toBe(ALDRIC);
    expect(entries[0]?.correlation.threadId).toBe(threadId);
    // One record per call, however often it is written.
    expect(activity.commands).toHaveLength(1);
    expect(activity.commands[0]?.output?.head).toBe("formatted\n");
  });

  // covers UX-002
  it("[TC-IN-174] rewrites a folder's changes as later scans find them, removing a file put back", async () => {
    const { first, second, activity } = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* ActivityRepository;
        const first = Option.getOrThrow(
          yield* repo.saveChanges(attemptId, project, [change("a.md", false), change("b.md", false)]),
        );
        const second = Option.getOrThrow(
          yield* repo.saveChanges(attemptId, project, [change("b.md", true, version("h3", contents(4)))]),
        );
        return { first, second, activity: Option.getOrThrow(yield* repo.read(attemptId)) };
      }),
    );
    expect(first.value.changes.map((each) => each.path)).toEqual(["a.md", "b.md"]);
    expect(second.value.removed).toEqual([FileChangeId.make("change-a.md")]);
    // The settled change registers the file it left as an artifact of the Task's thread (ADR 037).
    expect(second.entries.map((entry) => entry.payload)).toMatchObject([
      { _tag: "FileChangesRecorded", attemptId, taskId, folder: project, removed: ["change-a.md"] },
      {
        _tag: "ArtifactRegistered",
        artifact: {
          locator: `${project}/b.md`,
          kind: "doc",
          latestVersion: 1,
          origin: { kind: "attempt", id: attemptId },
        },
      },
    ]);
    expect(activity.changes).toHaveLength(1);
    expect(activity.changes[0]).toMatchObject({ path: "b.md", settled: true, after: { hash: "h3" } });
  });

  // covers UX-002
  it("[TC-IN-493] keeps an Attempt's steps outside any chat, replacing them whole as they change, and journals each write (#892)", async () => {
    const searching = {
      id: "s1",
      kind: "tool" as const,
      label: "Searching GitHub",
      state: "running" as const,
      call: { tool: "mcp__hobbots__github_search", operation: "github.read" as const, targets: [project] },
      startedAt: now,
    };
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* ActivityRepository;
        const first = yield* repo.saveSteps(attemptId, [searching], now);
        const second = yield* repo.saveSteps(attemptId, [{ ...searching, state: "done" }], later);
        const missing = yield* repo.saveSteps(AttemptId.make("missing"), [searching], later);
        const events = yield* (yield* EventJournal).readAfter(0);
        return {
          first,
          second,
          missing,
          stored: yield* repo.readSteps(attemptId),
          read: Option.map(yield* repo.read(attemptId), (activity) => activity.steps),
          none: yield* repo.readSteps(AttemptId.make("missing")),
          journaled: events.filter((event) => event.type === "AttemptStepsRecorded").length,
        };
      }),
    );
    expect(Option.isSome(result.first) && Option.isSome(result.second)).toBe(true);
    expect(result.missing).toEqual(Option.none());
    expect(result.stored).toEqual([{ ...searching, state: "done" }]);
    expect(result.read).toEqual(Option.some([{ ...searching, state: "done" }]));
    expect(result.none).toEqual([]);
    expect(result.journaled).toBe(2);
  });

  // covers UX-002
  it("[TC-IN-524] reads several Attempts' records at once, in the order asked, each as its own read finds it (#899)", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const tasks = yield* TaskRepository;
        const repo = yield* ActivityRepository;
        // A second Attempt of the same Task, sharing a folder with the first.
        const second = AttemptId.make("a2");
        yield* tasks.updateAttempt(attemptId, { _tag: "Ended", end: { _tag: "Failed", reason: "It broke." }, at: now });
        const revision = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks[0]?.revision ?? 0;
        yield* tasks.startAttempt(taskId, revision, {
          id: second,
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: later,
        });
        yield* repo.saveCommand(command("succeeded"));
        yield* repo.saveChanges(attemptId, project, [change("a.md", true)]);
        yield* repo.saveChanges(second, project, [{ ...change("b.md", true), sharedWith: [attemptId] }]);
        yield* repo.saveSteps(second, [{ id: "s1", kind: "tool", label: "Reading", state: "done" }], later);
        return {
          many: yield* repo.readMany([second, AttemptId.make("missing"), attemptId, second]),
          first: Option.getOrThrow(yield* repo.read(attemptId)),
          second: Option.getOrThrow(yield* repo.read(second)),
          none: yield* repo.readMany([]),
        };
      }),
    );
    expect(result.many).toEqual([result.second, result.first]);
    expect(result.second).toMatchObject({
      attempt: { id: "a2", number: 2 },
      commands: [],
      changes: [{ path: "b.md" }],
      steps: [{ id: "s1" }],
      sharedWithHobs: [{ attemptId, agentId: ALDRIC }],
    });
    expect(result.first).toMatchObject({ commands: [{ id: "c1" }], changes: [{ path: "a.md" }], steps: [] });
    expect(result.none).toEqual([]);
  });

  it("[TC-IN-175] writes nothing for an Attempt that is not there", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* ActivityRepository;
        const missing = AttemptId.make("missing");
        return {
          command: yield* repo.saveCommand({ ...command("running"), attemptId: missing }),
          changes: yield* repo.saveChanges(missing, project, [change("a.md", true)]),
          scan: yield* repo.saveScan({
            id: FolderScanId.make("s1"),
            attemptId: missing,
            folder: project,
            phase: "start",
            filesScanned: 3,
            stopped: null,
            startedAt: now,
            endedAt: now,
          }),
          read: yield* repo.read(missing),
        };
      }),
    );
    expect(result).toEqual({
      command: Option.none(),
      changes: Option.none(),
      scan: Option.none(),
      read: Option.none(),
    });
  });

  // covers UX-002, PE-005
  it("[TC-IN-176] serves only the contents an Attempt's records name, and says which kept contents no record names", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const repo = yield* ActivityRepository;
        yield* repo.saveCommand(command("succeeded"));
        yield* repo.saveChanges(attemptId, project, [change("a.md", true)]);
        yield* repo.saveScan({
          id: FolderScanId.make("s1"),
          attemptId,
          folder: project,
          phase: "end",
          filesScanned: 100_001,
          stopped: "too-many-files",
          startedAt: now,
          endedAt: later,
        });
        return {
          log: yield* repo.names(attemptId, contents(1)),
          after: yield* repo.names(attemptId, contents(3)),
          other: yield* repo.names(AttemptId.make("other"), contents(3)),
          unnamed: yield* repo.unnamed([contents(1), contents(2), contents(3), contents(5)]),
          scans: Option.getOrThrow(yield* repo.read(attemptId)).scans,
        };
      }),
    );
    expect(result.log).toBe(true);
    expect(result.after).toBe(true);
    expect(result.other).toBe(false);
    expect(result.unnamed).toEqual([contents(5)]);
    expect(result.scans).toMatchObject([{ folder: project, stopped: "too-many-files", filesScanned: 100_001 }]);
  });

  // covers UX-002
  it("[TC-IN-177] clears the details of a Task that ended past the window, keeping its records, and none of an open one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const started = yield* seed;
        const repo = yield* ActivityRepository;
        yield* repo.saveCommand(command("succeeded"));
        yield* repo.saveChanges(attemptId, project, [change("a.md", true)]);
        const whileOpen = yield* repo.clearDetails("2026-12-31T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
        const tasks = yield* TaskRepository;
        yield* tasks.updateAttempt(attemptId, {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "It stopped." },
          at: later,
        });
        const task = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks[0];
        yield* tasks.moveTask(taskId, task?.revision ?? started.value.task.revision, "failed", later);
        const tooSoon = yield* repo.clearDetails(later, "2026-11-03T00:00:00.000Z");
        const cleared = yield* repo.clearDetails("2026-12-31T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
        return {
          whileOpen,
          tooSoon,
          cleared,
          activity: Option.getOrThrow(yield* repo.read(attemptId)),
          named: yield* repo.names(attemptId, contents(3)),
          unnamed: yield* repo.unnamed([contents(1), contents(2), contents(3)]),
        };
      }),
    );
    expect(result.whileOpen).toBe(0);
    expect(result.tooSoon).toBe(0);
    expect(result.cleared).toBe(2);
    expect(result.activity.detailsClearedAt).toBe("2026-12-31T00:00:00.000Z");
    expect(result.activity.commands[0]).toMatchObject({ command: "npm run format", logNotKept: "cleared" });
    expect(result.activity.commands[0]?.log?.contentId).toBeNull();
    expect(result.activity.changes[0]).toMatchObject({
      path: "a.md",
      before: { hash: "h1", contentId: null, notKept: "cleared" },
      after: { hash: "h2", contentId: null, notKept: "cleared" },
    });
    expect(result.named).toBe(false);
    expect(result.unnamed).toEqual([contents(1), contents(2), contents(3)]);
  });
});
