import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ActivityRecorder,
  HobbotsRepository,
  HobTools,
  makeRedactor,
  type RuntimeEvent,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  DEFAULT_ACTIVITY_LIMITS,
  EMPTY_HOB_POLICY,
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
import { ActivityStoreLive, FolderScannerLive, GitWorkspaceLive } from "@hobbots/workbench";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #586, after review: a hob edits a file and calls complete_task in the same breath, before
// the scan its edit set off has run. The completion still sees the edit, through the hub's own
// recorder, Task tools and Git reader, with the records on SQLite or PostgreSQL (TestDatabase).

const now = "2026-11-03T01:21:55.000Z";
const FRODO = AgentId.make("frodo");
const threadId = ThreadId.make("spec");
const TASK = TaskId.make("wrap-up");
const ATTEMPT = AttemptId.make("wrap-up-1");

let work: string;
let site: string;

const SiteTools = Layer.sync(HobTools, () =>
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
        commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
      }),
  }),
);

const App = TaskTools.layer(sep === "\\" ? "\\" : "/").pipe(
  Layer.provideMerge(
    ActivityRecorder.layer(DEFAULT_ACTIVITY_LIMITS).pipe(
      Layer.provideMerge(
        Layer.merge(
          FolderScannerLive,
          Layer.suspend(() => ActivityStoreLive(join(work, "store"))),
        ),
      ),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeFolderChecks, SiteTools, FakeRuntimeLayer(), GitWorkspaceLive)),
  Layer.provideMerge(
    Layer.mergeAll(
      HobbotsRepositoryLive,
      TaskRepositoryLive,
      TaskToolCallsLive,
      ActivityRepositoryLive,
      EventJournal.layer,
      EventBus.layer,
    ).pipe(Layer.provideMerge(TestDatabase)),
  ),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;

const gitIn = (dir: string, ...args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=Nettle", "-c", "user.email=nettle@example.com", ...args],
    { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-uncommitted-scan-")));
  site = join(work, "site");
  mkdirSync(join(site, "docs"), { recursive: true });
  writeFileSync(join(site, "docs", "SPEC.md"), "# Spec\n");
  gitIn(site, "init", "-q");
  gitIn(site, "add", ".");
  gitIn(site, "commit", "-q", "-m", "First version");
  runtime = ManagedRuntime.make(App);
});

afterEach(async () => {
  await runtime.dispose();
  rmSync(work, { recursive: true, force: true });
});

const seed = Effect.gen(function* () {
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
  yield* repo.upsertThread(new Thread({ id: threadId, agentId: FRODO, title: "Spec", createdAt: now, updatedAt: now }));
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
});

/** Frodo's turn: its Edit rewrites the spec, and the same turn calls complete_task right after. */
const editThenComplete = Effect.scoped(
  Effect.gen(function* () {
    const turn = yield* (yield* ActivityRecorder).forTurn({
      folders: [work],
      attempt: Effect.succeed(ATTEMPT),
      redactor: makeRedactor(),
    });
    const spec = join(site, "docs", "SPEC.md");
    const edit: RuntimeEvent = {
      _tag: "ToolStarted",
      id: "edit",
      tool: "Edit",
      operation: "edit-files",
      targets: [spec],
      label: "Editing docs/SPEC.md",
    };
    const tools = yield* TaskTools;
    let done: TaskToolDone | null = null;
    yield* Stream.runDrain(
      turn.run(
        {
          prompt: "",
          sessionId: null,
          instructions: "",
          instructionsChanged: false,
          model: null,
          effort: null,
          tools: null,
          recordToolStart: () => Effect.succeed(true),
        },
        (request) =>
          Stream.fromEffect(
            Effect.as(request.recordToolStart ? request.recordToolStart(edit as never) : Effect.void, edit),
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.sync((): RuntimeEvent => {
                  writeFileSync(spec, "# Spec\n\nWrapped up.\n");
                  return { _tag: "ToolFinished", id: "edit", failed: false };
                }),
              ),
            ),
            // The hub call comes while the turn still runs, right after the edit ended.
            Stream.concat(
              Stream.fromEffect(
                Effect.map(
                  tools.call({ agentId: FRODO, taskId: TASK }, "complete_task", {
                    delivered: true,
                    key: "done",
                    task_id: TASK,
                    summary: "Spec wrapped up",
                  }),
                  (result): RuntimeEvent => {
                    done = result;
                    return { _tag: "TextDelta", text: "" } as RuntimeEvent;
                  },
                ),
              ),
            ),
          ),
      ),
    );
    return done as TaskToolDone | null;
  }),
);

describe("Completing a Task right after an edit", () => {
  // covers OR-004
  it("[TC-OR-291] sees the edit its turn made, before the edit's own scan has run", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const done = yield* editThenComplete;
        const tree = Option.getOrThrow(yield* (yield* TaskRepository).readTree(TASK));
        return { done, left: tree.checkpoints.filter((each) => each.kind === "uncommitted") };
      }),
    );
    expect(result.done?.message).toContain("Warning: 1 file you changed is not committed: docs/SPEC.md in");
    expect(result.left.map((each) => each.summary)).toEqual([
      `Left 1 file uncommitted since the last commit: docs/SPEC.md in ${site}.`,
    ]);
  });
});
