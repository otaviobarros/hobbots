import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ActivityRepository,
  type FileChangeDraft,
  HobbotsRepository,
  HobTools,
  RuntimeAdapter,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  EMPTY_HOB_POLICY,
  FileChangeId,
  TaskId,
  type TaskToolDone,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { TaskTools } from "@hobbots/orchestration";
import {
  ActivityRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { GitWorkspaceLive } from "@hobbots/workbench";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #586: a Task could complete with files it changed in a Git repository still uncommitted,
// and nothing said so. complete_task now warns its hob and keeps what was left on the Task, with
// the Git state read by the hub's own reader, the records on SQLite or PostgreSQL (TestDatabase).

const now = "2026-11-03T01:21:55.000Z";
const FRODO = AgentId.make("frodo");
const threadId = ThreadId.make("spec");
const TASK = TaskId.make("wrap-up");
const ATTEMPT = AttemptId.make("wrap-up-1");

let work: string;

const TestHobTools = Layer.sync(HobTools, () =>
  HobTools.of({
    access: () =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(work, "data"),
          restrictions: [],
        },
        folders: [work],
        runtimeFolder: join(work, "runtime"),
      }),
  }),
);

const Persistence = Layer.mergeAll(
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  ActivityRepositoryLive,
  EventJournal.layer,
).pipe(Layer.provideMerge(TestDatabase));
const App = TaskTools.layer(sep === "\\" ? "\\" : "/").pipe(
  Layer.provideMerge(
    Layer.mergeAll(Persistence, EventBus.layer, NodeFolderChecks, TestHobTools, FakeRuntimeLayer(), GitWorkspaceLive),
  ),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;

/** Runs Git in the test repository as a person would, with an identity of its own and no user config. */
const gitIn = (dir: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Nettle",
      GIT_AUTHOR_EMAIL: "nettle@example.com",
      GIT_COMMITTER_NAME: "Nettle",
      GIT_COMMITTER_EMAIL: "nettle@example.com",
    },
  });

/** The test repository, `site`, with one commit holding the spec and the readme. */
const repository = () => {
  const site = join(work, "site");
  mkdirSync(join(site, "docs"), { recursive: true });
  writeFileSync(join(site, "docs", "SPEC.md"), "# Spec\n");
  writeFileSync(join(site, "README.md"), "# Site\n");
  gitIn(site, "init", "-q");
  gitIn(site, "add", ".");
  gitIn(site, "commit", "-q", "-m", "First version");
  return site;
};

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-uncommitted-")));
  runtime = ManagedRuntime.make(App);
});

afterEach(async () => {
  await runtime.dispose();
  rmSync(work, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof App>>) => runtime.runPromise(effect);

/** Frodo's Task with one running Attempt, which changed `paths` in the work folder. */
const seed = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(
      new Agent({
        id: FRODO,
        name: "Frodo",
        roleTitle: "Lead",
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
      new Thread({ id: threadId, agentId: FRODO, title: "Spec", createdAt: now, updatedAt: now }),
    );
    const tasks = yield* TaskRepository;
    const created = yield* tasks.createTask({
      task: { id: TASK, ownerId: FRODO, parentId: null, threadId, brief: "Wrap up", dependsOn: [], createdAt: now },
      delegation: null,
      milestones: [],
    });
    yield* tasks.startAttempt(TASK, created.value.revision, {
      id: ATTEMPT,
      runtime: "claude-code",
      sessionId: null,
      configVersion: 1,
      policyVersion: null,
      startedAt: now,
    });
    const drafts = paths.map(
      (path): FileChangeDraft => ({
        id: FileChangeId.make(`change-${path}`),
        path,
        kind: "edited",
        movedFrom: null,
        before: null,
        after: null,
        sharedWith: [],
        settled: true,
        recordedAt: now,
      }),
    );
    yield* (yield* ActivityRepository).saveChanges(ATTEMPT, work, drafts);
  });

const complete = (summary: string) =>
  Effect.flatMap(Effect.service(TaskTools), (tools) =>
    tools.call({ agentId: FRODO, taskId: TASK }, "complete_task", { key: "done-1", task_id: TASK, summary }),
  ) as Effect.Effect<TaskToolDone, unknown, Layer.Success<typeof App>>;

const checkpoints = Effect.gen(function* () {
  const tree = Option.getOrThrow(yield* (yield* TaskRepository).readTree(TASK));
  return { task: tree.tasks[0], checkpoints: tree.checkpoints.filter((each) => each.kind === "uncommitted") };
});

describe("Completing a Task that changed a Git repository", () => {
  // covers OR-004
  it("[TC-OR-284] still completes, warns its hob and keeps the files it left uncommitted, named by repository", async () => {
    const site = repository();
    // The spec is edited after the commit, a new note is never added, and the readme is committed again.
    writeFileSync(join(site, "docs", "SPEC.md"), "# Spec\n\nWrapped up.\n");
    writeFileSync(join(site, "NOTES.md"), "Loose ends\n");
    writeFileSync(join(site, "README.md"), "# Site\n\nNow with a badge.\n");
    gitIn(site, "commit", "-q", "-m", "Readme", "--", "README.md");
    writeFileSync(join(work, "outside.txt"), "Not in any repository\n");
    const result = await run(
      Effect.gen(function* () {
        yield* seed(["site/docs/SPEC.md", "site/NOTES.md", "site/README.md", "outside.txt"]);
        const done = yield* complete("Spec wrapped up");
        return { done, ...(yield* checkpoints) };
      }),
    );
    expect(result.task?.state).toBe("completed");
    expect(result.done.message).toContain(`Task ${TASK} is complete. Warning: 2 files you changed are not committed`);
    expect(result.done.message).toContain(`NOTES.md and docs/SPEC.md in ${site}`);
    expect(result.done.message).not.toContain("README.md");
    expect(result.done.message).not.toContain("outside.txt");
    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0]).toMatchObject({
      source: "automatic",
      kind: "uncommitted",
      attemptId: ATTEMPT,
      summary: `Left 2 files uncommitted since the last commit: NOTES.md and docs/SPEC.md in ${site}.`,
    });
  });

  // covers OR-004 (#665)
  it("[TC-OR-461] holds the Quest's top Task once on files it left uncommitted, and completes when its lead says why", async () => {
    const site = repository();
    writeFileSync(join(site, "docs", "SPEC.md"), "# Spec\n\nEdited after the commit.\n");
    // One turn of the fake runtime: the lead completes, is told which file, and leaves it on purpose.
    const prompt = [
      "Wrap up the Quest",
      'fake:hub complete_task {"key":"done-1","summary":"Spec wrapped up"}',
      'fake:hub complete_task {"key":"done-2","summary":"Spec wrapped up","leave_uncommitted":"You asked to review the spec before it is committed."}',
    ].join("\n");
    const result = await run(
      Effect.gen(function* () {
        yield* seed(["site/docs/SPEC.md"]);
        const tools = yield* TaskTools;
        yield* tools.call({ agentId: FRODO, taskId: TASK }, "start_quest", { key: "quest", goal: "Wrap up the spec" });
        const adapter = yield* RuntimeAdapter;
        const events = yield* Stream.runCollect(
          adapter.sendPrompt({
            prompt,
            sessionId: null,
            instructions: "",
            instructionsChanged: false,
            model: null,
            effort: null,
            hubTools: tools.forTurn({ agentId: FRODO, taskId: TASK }),
          }),
        );
        return { events, ...(yield* checkpoints) };
      }),
    );
    const completed = result.events.find((event) => event._tag === "Completed");
    const text = completed?._tag === "Completed" ? completed.text : "";
    expect(text).toContain(
      `complete_task: Refused (uncommitted-changes): Task ${TASK} changed 1 file it has not committed: docs/SPEC.md in ${site}. Commit them if the work asked for a commit`,
    );
    expect(text).toContain(`complete_task: Task ${TASK} is complete.`);
    expect(result.task?.state).toBe("completed");
    expect(result.checkpoints).toEqual([
      expect.objectContaining({
        kind: "uncommitted",
        summary: `Left 1 file uncommitted since the last commit: docs/SPEC.md in ${site}. Left on purpose: You asked to review the spec before it is committed.`,
      }),
    ]);
  });

  // covers OR-004
  it("[TC-OR-285] says nothing more when everything it changed is committed, or it changed no repository", async () => {
    const site = repository();
    writeFileSync(join(site, "docs", "SPEC.md"), "# Spec\n\nWrapped up.\n");
    gitIn(site, "commit", "-q", "-am", "Spec");
    const result = await run(
      Effect.gen(function* () {
        yield* seed(["site/docs/SPEC.md"]);
        const done = yield* complete("Spec wrapped up");
        return { done, ...(yield* checkpoints) };
      }),
    );
    expect(result.done.message).toBe(`Task ${TASK} is complete.`);
    expect(result.checkpoints).toEqual([]);
  });
});
