import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ActivityRecorder,
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
  RuntimeAdapter,
  type RuntimeEvent,
  SecretRedaction,
  TaskFiles,
} from "@hobbots/agents";
import type { AttemptActivityRead, ThreadTasksRead } from "@hobbots/api";
import {
  type Agent,
  type AttemptFiles,
  type CommandOutput,
  type EventEnvelope,
  isInProgress,
  isLiveAttempt,
  type Message,
  roleFields,
  type TaskTree,
  type Thread,
} from "@hobbots/domain";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ActivityRepositoryLive,
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { ActivityStoreLive, FolderScannerLive, HobFilesLive } from "@hobbots/workbench";
import { Deferred, Effect, Layer, Schedule, Stream } from "effect";
import { makeParser } from "effect/encoding/Sse";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { EventStream, EventStreamRoute } from "../src/event-stream.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { TaskFileRoute } from "../src/task-files.ts";
import { ToolLogsLive } from "../src/tool-logs.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Issue #391: the Workbench's done-when checks (ADR 023), played over the HTTP API and the event
// stream as the Workbench reads them, with the hub's own composition of the recorder, the folder
// scanner, the store and the Task's files, the fake runtime changing a real folder, and the records
// on SQLite or PostgreSQL (TestDatabase). The browser side of the same checks is in
// apps/web/e2e/workbench-end-to-end.e2e.ts.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-workbench-e2e-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const dataDir = join(temp, "data");
mkdirSync(dataDir, { recursive: true });

/** A prompt with this line of its own holds its turn open, once its work is done, until the test lets it end. */
const HOLD = "fake:hold";
/** A token as a command could print it. */
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const HUB_SECRET = "hub-credential-0123456789";
/** The journal entries the Workbench's records commit with. */
const WORKBENCH_RECORDS: ReadonlySet<string> = new Set(["CommandRecorded", "FileChangesRecorded", "FolderScanned"]);

let project = "";
let projects = 0;
let gate = Deferred.makeUnsafe<void>();
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

/** The fake runtime, with a turn whose prompt holds `HOLD` kept from completing until the gate opens. */
const HeldRuntime = Layer.effect(
  RuntimeAdapter,
  Effect.gen(function* () {
    const fake = yield* RuntimeAdapter;
    return RuntimeAdapter.of({
      ...fake,
      sendPrompt: (request) => {
        const stream = fake.sendPrompt(request);
        if (!request.prompt.split("\n").some((line) => line.trim() === HOLD)) return stream;
        return stream.pipe(
          Stream.mapEffect(
            (event): Effect.Effect<RuntimeEvent> =>
              event._tag === "Completed" ? Effect.as(Deferred.await(gate), event) : Effect.succeed(event),
          ),
        );
      },
    });
  }),
).pipe(Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))));

beforeEach(() => {
  project = join(temp, `project-${++projects}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "# Release notes\n");
  writeFileSync(join(project, "draft.txt"), "An old draft.\n");
  gate = Deferred.makeUnsafe<void>();
  const activity = join(dataDir, `activity-${projects}`);
  const App = Layer.mergeAll(HobLifecycle.layer, EventStream.layer)
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    // As the hub composes them: a Task's steps run beside the chat, and every turn records what it
    // ran and changed for the Workbench, its details kept out of every hob's reach.
    .pipe(
      Layer.provideMerge(
        StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
      ),
    )
    .pipe(
      Layer.provideMerge(
        Layer.merge(ActivityRecorder.layer(), TaskFiles.layer.pipe(Layer.provide(HobFilesLive))).pipe(
          Layer.provideMerge(Layer.merge(FolderScannerLive, ActivityStoreLive(activity))),
        ),
      ),
    )
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
            TaskToolCallsLive,
            ActivityRepositoryLive,
            EventJournal.layer,
            BackpackLive,
            SetupRepository.layer,
            SearchIndex.layer,
          ).pipe(Layer.provideMerge(TestDatabase)),
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
          HeldRuntime,
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
          SecretRedaction.layer([{ value: HUB_SECRET, kind: "HUB_TOKEN" }]),
          ToolLogsLive(join(dataDir, "tool-logs")),
        ),
      ),
    );
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(ApiRoutes, EventStreamRoute, TaskFileRoute).pipe(
      Layer.provideMerge(TestDevices),
      Layer.provideMerge(App),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});
afterEach(async () => {
  // A held turn is let go, so the hub stops without waiting on it.
  Deferred.doneUnsafe(gate, Effect.void);
  await dispose();
});

const address = (path: string) => `http://localhost:4391${path}`;

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(address(path), {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

/** A GET whose answer is text or bytes, as a log, kept contents and a served file are. */
const fetched = (path: string) => handler(new Request(address(path), { headers: AS_WINDOW }));

const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
      Effect.mapError(() => new Error(`still waiting for ${read.toString().slice(0, 300)}`)),
    ),
  );

const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
const run = (command: object) => `fake:run ${JSON.stringify(command)}`;

/** A finished setup on Balanced sharing the project folder, with Aldric and one thread of his. */
const aldricWithThread = async () => {
  await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [project] });
  const aldric = (
    await request<Agent>("POST", "/api/agents", {
      name: "Aldric",
      ...roleFields("writer"),
      lookSeed: 4000,
      lookColor: "amber",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    })
  ).body;
  return (await request<Thread>("POST", `/api/agents/${aldric.id}/threads`)).body;
};

const messages = async (thread: Thread) =>
  (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body;

/** Sends `content` and waits until its reply has ended. */
const exchange = async (thread: Thread, content: string) => {
  const before = (await messages(thread)).length;
  expect((await request("POST", `/api/threads/${thread.id}/messages`, { content })).status).toBe(200);
  return eventually(async () => {
    const all = await messages(thread);
    const last = all.at(-1);
    return all.length >= before + 2 && last?.role === "assistant" && !isInProgress(last.status) ? last : undefined;
  });
};

/** The thread's one request, as the chat's card and the Workbench read it. */
const treeOf = async (thread: Thread): Promise<TaskTree> => {
  const [tree] = (await request<ThreadTasksRead>("GET", `/api/threads/${thread.id}/tasks`)).body.trees;
  if (tree === undefined) throw new Error("no Task in the thread");
  return tree;
};

const readActivity = async (attemptId: string) => {
  const read = await request<AttemptActivityRead>("GET", `/api/attempts/${attemptId}/activity`);
  expect(read.status).toBe(200);
  return read.body;
};

/** The Attempt's records once `ready` holds of them. */
const activityWhen = (attemptId: string, ready: (activity: AttemptActivityRead["activity"]) => boolean) =>
  eventually(async () => {
    const { activity } = await readActivity(attemptId);
    return ready(activity) ? activity : undefined;
  });

/** What the event stream sends a Workbench following it from `cursor`: journal entries, and running commands' output. */
const follow = async (cursor: string) => {
  const response = await handler(new Request(address(`/api/events?after=${cursor}`), { headers: AS_WINDOW }));
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const entries: Array<EventEnvelope> = [];
  const output: Array<CommandOutput> = [];
  const parser = makeParser((frame) => {
    if (frame._tag !== "Event") return;
    const data = JSON.parse(frame.data);
    if (frame.event === "message" && typeof data.type === "string") entries.push(data);
    else if (data._tag === "CommandOutput") output.push(data);
  });
  const pumping = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  })().catch(() => undefined);
  return { entries, output, stop: () => reader.cancel().then(() => pumping) };
};

/**
 * What the stream's entries say of one Attempt, as a Workbench following it builds its view: each
 * command's latest state by its id, each change's latest form by its path, and its scans in order.
 */
const streamed = (entries: ReadonlyArray<EventEnvelope>, attemptId: string) => {
  const commands = new Map<string, string>();
  const changes = new Map<string, { readonly kind: string; readonly settled: boolean }>();
  const scans: Array<string> = [];
  for (const { payload } of entries) {
    if (payload._tag === "CommandRecorded" && payload.command.attemptId === attemptId) {
      commands.set(payload.command.id, payload.command.state);
    } else if (payload._tag === "FileChangesRecorded" && payload.attemptId === attemptId) {
      for (const change of payload.changes) changes.set(change.path, { kind: change.kind, settled: change.settled });
    } else if (payload._tag === "FolderScanned" && payload.scan.attemptId === attemptId) {
      scans.push(payload.scan.phase);
    }
  }
  const sorted = [...changes].sort(([a], [b]) => a.localeCompare(b)).map(([path, change]) => ({ path, ...change }));
  return { commands: [...commands.values()], changes: sorted, scans };
};

describe("the Workbench, end to end", () => {
  // covers UX-002, UX-006, PE-005
  it("[TC-UX-060] a Task that edits files and runs commands reads Live while its turn runs, from the records and the event stream, and as History once it ends", async () => {
    const thread = await aldricWithThread();
    // The first turn starts the Task, so the next turn's work belongs to its Attempt.
    await exchange(
      thread,
      ["Write the release notes", script("start_quest", { key: "quest", goal: "Write the release notes" })].join("\n"),
    );
    // The turn's Attempt ends just after its reply; the next turn on the Task resumes it.
    const started = await eventually(async () => {
      const read = (await request<ThreadTasksRead>("GET", `/api/threads/${thread.id}/tasks`)).body;
      return read.trees[0]?.attempts.every((attempt) => attempt.state === "completed") ? read : undefined;
    });
    const task = started.trees[0]?.tasks[0];
    if (task === undefined) throw new Error("no Task");

    // The Workbench follows the stream from the cursor of what it read.
    const stream = await follow(started.cursor);

    // Aldric edits the notes with a file tool, runs a command that rewrites one file, adds one and
    // deletes another, printing a token as it goes, and runs one more that prints a lot.
    const sent = request("POST", `/api/threads/${thread.id}/messages`, {
      content: [
        "Finish the notes",
        'fake:write notes.md "# Release notes\\n\\n- Faster search.\\n"',
        run({
          command: `npm run changelog -- --token ${TOKEN}`,
          writes: { "CHANGELOG.md": "## 1.2.0\n\n- Faster search.\n", "draft.txt": null },
          output: `Wrote CHANGELOG.md\nused ${HUB_SECRET}\n`,
          live: true,
        }),
        "fake:tool Bash seq 30000",
        HOLD,
      ].join("\n"),
    });
    expect((await sent).status).toBe(200);

    // Live: the turn is held open once its work is done, and its Attempt's records already show all of it.
    const attemptId = await eventually(async () => {
      const tree = await treeOf(thread);
      return tree.attempts.find((attempt) => attempt.number === 1 && isLiveAttempt(attempt.state))?.id;
    });
    const read = await readActivity(attemptId);
    const live = await activityWhen(
      attemptId,
      (each) =>
        each.commands.length === 2 &&
        each.commands.every((command) => command.state !== "running") &&
        each.changes.length === 3,
    );
    expect(isLiveAttempt(live.attempt.state)).toBe(true);
    expect(
      live.commands.map(({ command, folder, sandboxed, state, liveOutput }) => ({
        command,
        folder,
        sandboxed,
        state,
        liveOutput,
      })),
    ).toEqual([
      {
        command: "npm run changelog -- --token [redacted: GitHub token]",
        folder: project,
        sandboxed: true,
        state: "succeeded",
        liveOutput: true,
      },
      { command: "seq 30000", folder: project, sandboxed: true, state: "succeeded", liveOutput: false },
    ]);
    expect(live.commands[0]?.output?.head).toBe("Wrote CHANGELOG.md\nused [redacted: HUB_TOKEN]\n");
    // Each change as it was made, not settled until the end-of-turn compare.
    expect(live.changes.map(({ path, kind, settled }) => ({ path, kind, settled }))).toEqual([
      { path: "CHANGELOG.md", kind: "added", settled: false },
      { path: "draft.txt", kind: "deleted", settled: false },
      { path: "notes.md", kind: "edited", settled: false },
    ]);
    // The scans of the turn before it on the same Attempt stay with it.
    expect(live.scans.map((scan) => scan.phase)).toEqual(["start", "end", "start"]);
    // The same records reached the stream from the cursor, and the command's output as it came, redacted.
    const followed = () => streamed(stream.entries, attemptId);
    await eventually(async () =>
      followed().changes.length === 3 && followed().commands.length === 2 ? true : undefined,
    );
    expect(followed()).toEqual({
      commands: ["succeeded", "succeeded"],
      changes: live.changes.map(({ path, kind, settled }) => ({ path, kind, settled })),
      scans: ["start"],
    });
    expect(stream.output.map((piece) => piece.delta).join("")).toBe("Wrote CHANGELOG.md\nused [redacted: HUB_TOKEN]\n");
    const recorded = JSON.stringify(stream.entries.filter((entry) => WORKBENCH_RECORDS.has(entry.type)));
    expect(recorded).not.toContain(TOKEN);
    expect(recorded).not.toContain(HUB_SECRET);

    // History: the turn ends, the end-of-turn compare settles each change, and nothing was lost.
    Deferred.doneUnsafe(gate, Effect.void);
    const after = await activityWhen(
      attemptId,
      (each) => !isLiveAttempt(each.attempt.state) && each.scans.some((scan) => scan.phase === "end"),
    );
    expect(after.attempt.state).toBe("completed");
    expect(after.commands.map((command) => command.command)).toEqual(live.commands.map((command) => command.command));
    expect(after.changes.map(({ path, kind, settled }) => ({ path, kind, settled }))).toEqual([
      { path: "CHANGELOG.md", kind: "added", settled: true },
      { path: "draft.txt", kind: "deleted", settled: true },
      { path: "notes.md", kind: "edited", settled: true },
    ]);
    expect(after.scans.map((scan) => scan.phase)).toEqual(["start", "end", "start", "end"]);
    // The stream brought the end-of-turn compare too, so a Workbench following it settles without reading again.
    const settled = after.changes.map(({ path, kind, settled }) => ({ path, kind, settled }));
    await eventually(async () => (followed().scans.length === 2 ? true : undefined));
    expect(followed()).toEqual({ commands: ["succeeded", "succeeded"], changes: settled, scans: ["start", "end"] });
    await stream.stop();
    // One that lost its connection mid-turn catches up from the cursor of its read.
    const resumed = await follow(read.cursor);
    await eventually(async () => (streamed(resumed.entries, attemptId).scans.includes("end") ? true : undefined));
    expect(streamed(resumed.entries, attemptId).changes).toEqual(settled);
    await resumed.stop();

    // Changes: the notes before and after, and what the deleted draft held.
    const kept = async (path: string, side: "before" | "after") => {
      const contentId = after.changes.find((change) => change.path === path)?.[side]?.contentId;
      const response = await fetched(`/api/attempts/${attemptId}/contents/${contentId}`);
      expect(response.status).toBe(200);
      return response.text();
    };
    expect(await kept("notes.md", "before")).toBe("# Release notes\n");
    expect(await kept("notes.md", "after")).toBe("# Release notes\n\n- Faster search.\n");
    expect(await kept("draft.txt", "before")).toBe("An old draft.\n");

    // Terminal: the long output's whole log, though its record keeps only its start and end.
    const long = after.commands[1];
    expect(long?.output?.omittedBytes).toBeGreaterThan(0);
    const log = await fetched(`/api/attempts/${attemptId}/commands/${long?.id}/log`);
    expect((await log.text()).split("\n")).toHaveLength(30_001);

    // Files: what the Task made or touched, as it is now, served for a preview.
    const files = (await request<AttemptFiles>("GET", `/api/attempts/${attemptId}/files`)).body;
    expect(files.files.map((file) => file.path).toSorted()).toEqual(["CHANGELOG.md", "notes.md"]);
    const changelog = files.files.find((file) => file.path === "CHANGELOG.md");
    const served = await fetched(`/api/attempts/${attemptId}/files/${changelog?.id}`);
    expect(await served.text()).toBe("## 1.2.0\n\n- Faster search.\n");
  }, 60_000);

  // covers UX-002, UX-006
  it("[TC-UX-061] a Task that runs no command records none, so its Terminal is not used, while its changes and files are kept", async () => {
    const thread = await aldricWithThread();
    await exchange(
      thread,
      [
        "Tidy the notes",
        'fake:write notes.md "# Release notes\\n\\nTidied.\\n"',
        script("start_quest", { key: "quest", goal: "Tidy the notes" }),
        script("complete_task", { key: "done", summary: "The notes are tidy." }),
      ].join("\n"),
    );
    const tree = await treeOf(thread);
    expect(tree.tasks[0]?.state).toBe("completed");
    const attemptId = tree.attempts[0]?.id;
    if (attemptId === undefined) throw new Error("no Attempt");

    // History once its Attempt has ended, which lands just after its end-of-turn compare.
    const activity = await activityWhen(
      attemptId,
      (each) => !isLiveAttempt(each.attempt.state) && each.scans.some((scan) => scan.phase === "end"),
    );
    expect(activity.commands).toEqual([]);
    expect(activity.changes.map(({ path, kind, settled }) => ({ path, kind, settled }))).toEqual([
      { path: "notes.md", kind: "edited", settled: true },
    ]);
    const files = (await request<AttemptFiles>("GET", `/api/attempts/${attemptId}/files`)).body;
    expect(files.files.map((file) => file.path)).toEqual(["notes.md"]);
  }, 30_000);
});
