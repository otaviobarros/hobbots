import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ActivityRepository,
  DataExport,
  HobbotsRepository,
  MemoryStore,
  type NewAttempt,
  SecretRedaction,
  TaskRepository,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ArtifactId,
  AttemptId,
  CommandId,
  CriterionId,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  EMPTY_HOB_POLICY,
  type ExportScope,
  FileChangeId,
  HobbotsExport,
  MemoryPath,
  Message,
  MessageId,
  memoryProjectIdentity,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import {
  ActivityRepositoryLive,
  EventJournal,
  HobbotsRepositoryLive,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { HobFilesLive } from "@hobbots/workbench";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SaveDestinationsLive } from "../src/destination.ts";
import { EventBus } from "../src/event-bus.ts";
import { ExportFoldersLive } from "../src/exports.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #453: exports of ADR 026. One thread, one hob or everything, as a folder of Markdown and
// versioned JSON that opens without Hobbots, with the files the Tasks made, every string redacted,
// and nothing a backup alone may hold: no device record, token hash or credential.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-export-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
/** Aldric's own folder, where its Task left its files. */
const project = join(temp, "project");
/** Where the exports go: no hob works there. */
const saved = join(temp, "saved");
const workspace = join(temp, "data", "workspaces", "default");

const AT = "2026-11-02T10:00:00.000Z";
const LATER = "2026-11-02T11:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const CAMPAIGN = ThreadId.make("campaign");
const NOTES = ThreadId.make("notes");
const QUILL_THREAD = ThreadId.make("quill-own");
/** The hub's own credential, known by value, and a token you pasted into a message, known by its shape. */
const HUB_SECRET = "hub-credential-0123456789";
const PASTED = `ghp_${"a1B2".repeat(9)}`;
/** A device's token hash, which only a backup may hold, and only blank. */
const TOKEN_HASH = "f".repeat(64);
const REPORT = `# Launch report\n\nAll set. Deploy with ${PASTED}.\n`;
/** A binary file with the hub's secret in it: not text the redactor can rewrite. */
const DUMP = Uint8Array.from([0, 0xff, ...new TextEncoder().encode(HUB_SECRET), 0xfe, 0]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const hob = (id: AgentId, name: string, ownFolders: ReadonlyArray<string>) =>
  new Agent({
    id,
    name,
    roleTitle: "Marketing",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: `Use ${HUB_SECRET} when you must.`,
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: AT,
    policy: { ...EMPTY_HOB_POLICY, ownFolders },
  });

const message = (id: string, threadId: ThreadId, role: "user" | "assistant", content: string, at = AT) =>
  new Message({
    id: MessageId.make(id),
    threadId,
    role,
    content,
    status: "complete",
    error: null,
    configVersion: role === "assistant" ? 1 : null,
    steps:
      role === "assistant"
        ? [
            {
              id: "s1",
              kind: "tool",
              label: "Running pnpm test",
              state: "done",
              call: { tool: "Bash", operation: "run-commands", targets: [project] },
            },
          ]
        : [],
    createdAt: at,
  });

const attempt = (id: string): NewAttempt => ({
  id: AttemptId.make(id),
  runtime: "claude-code",
  sessionId: null,
  configVersion: 1,
  policyVersion: null,
  startedAt: AT,
});

/**
 * Aldric's campaign thread, with a token in your message, and a Quest that brought in Quill: Aldric's
 * Task made a report, a chart, an `.env` and a file since deleted, and ran a command; Quill drafted
 * copy with a brief only Quill's export holds. Quill also has a thread of its own.
 */
const seed = Effect.gen(function* () {
  yield* (yield* SetupRepository).update({ safetyPreset: "balanced", approvedFolders: [] });
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(hob(ALDRIC, "Aldric", [project]));
  yield* repo.insertAgent(hob(QUILL, "Quill", []));
  for (const [id, agentId, title] of [
    [CAMPAIGN, ALDRIC, "Black Friday campaign"],
    [NOTES, ALDRIC, "Notes / ideas"],
    [QUILL_THREAD, QUILL, "Quill's own chat"],
  ] as const) {
    yield* repo.upsertThread(new Thread({ id, agentId, title, createdAt: AT, updatedAt: AT }));
  }
  yield* repo.upsertMessage(
    message("m1", CAMPAIGN, "user", `Plan the campaign. My token is ${PASTED} and the hub's is ${HUB_SECRET}.`),
  );
  yield* repo.upsertMessage(message("m2", CAMPAIGN, "assistant", "On it. **Quill** drafts the copy.", LATER));
  yield* repo.upsertMessage(message("m3", NOTES, "user", "A note to self."));
  yield* repo.upsertMessage(message("m4", QUILL_THREAD, "user", "Hello Quill."));

  const tasks = yield* TaskRepository;
  const top = TaskId.make("campaign-task");
  yield* tasks.createTask({
    task: {
      id: top,
      ownerId: ALDRIC,
      parentId: null,
      threadId: CAMPAIGN,
      brief: "Run the Black Friday campaign\nWith a report.",
      dependsOn: [],
      createdAt: AT,
    },
    delegation: null,
    milestones: [],
  });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: top,
    goal: "A Black Friday campaign",
    acceptance: ["Copy approved"],
    // Optional, so the Quest completes without checks; quest-criteria.test.ts holds the gate.
    criteria: [{ id: CriterionId.make("c-copy"), text: "Copy approved", required: false }],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: AT,
  });
  yield* tasks.createTask({
    task: {
      id: TaskId.make("copy-task"),
      ownerId: QUILL,
      parentId: top,
      threadId: CAMPAIGN,
      brief: "Draft the copy\nQuill's private brief: mention the secret discount.",
      dependsOn: [],
      createdAt: LATER,
    },
    delegation: {
      id: DelegationId.make("d1"),
      brief: "Draft the copy",
      expectedOutput: null,
      authority: { overrides: {}, folders: null },
      timeoutMs: null,
    },
    milestones: [],
  });
  // Quill's own Quest under Aldric's: Aldric's export holds its goal and state, not its acceptance.
  yield* tasks.startQuest({
    id: QuestId.make("q2"),
    taskId: TaskId.make("copy-task"),
    goal: "Copy for every channel",
    acceptance: ["Quill's private acceptance"],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: LATER,
  });
  const created = Option.getOrThrow(yield* tasks.readTree(top)).tasks[0];
  if (created === undefined) throw new Error("no Task");
  const started = yield* tasks.startAttempt(top, created.revision, attempt("a1"));
  const activity = yield* ActivityRepository;
  yield* activity.saveCommand({
    id: CommandId.make("cmd1"),
    attemptId: AttemptId.make("a1"),
    stepId: "s1",
    command: "pnpm build",
    folder: project,
    sandboxed: true,
    liveOutput: false,
    state: "succeeded",
    exitCode: 0,
    startedAt: AT,
    endedAt: LATER,
    output: null,
    log: null,
    logNotKept: null,
  });
  yield* activity.saveChanges(AttemptId.make("a1"), project, [
    {
      id: FileChangeId.make("ch1"),
      path: "report.md",
      kind: "added",
      movedFrom: null,
      before: null,
      after: null,
      sharedWith: [],
      settled: true,
      recordedAt: LATER,
    },
  ]);
  // The copy Task is Quill's: Aldric's Task completes once Quill's has ended.
  const copy = Option.getOrThrow(yield* tasks.readTree(TaskId.make("copy-task"))).tasks[0];
  if (copy === undefined) throw new Error("no Task");
  yield* tasks.moveTask(copy.id, copy.revision, "cancelled", LATER);
  yield* tasks.completeTask(top, started.value.task.revision, {
    summary: "Campaign ready",
    attemptId: AttemptId.make("a1"),
    artifacts: [
      { id: ArtifactId.make("art-report"), kind: "file", label: "The report", value: join(project, "report.md") },
      { id: ArtifactId.make("art-chart"), kind: "file", label: "Chart", value: "chart #1.png" },
      { id: ArtifactId.make("art-dump"), kind: "file", label: "Dump", value: "dump.bin" },
      { id: ArtifactId.make("art-gone"), kind: "file", label: "Old draft", value: "draft.md" },
      { id: ArtifactId.make("art-env"), kind: "file", label: "Settings", value: ".env" },
      { id: ArtifactId.make("art-link"), kind: "link", label: "Store", value: "https://hobbots.app" },
    ],
    at: LATER,
    carried: carriedFrom(Option.getOrThrow(yield* tasks.readLedger(top)), () => true),
  });
  // A device the hub approved: an export never holds it.
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO devices (id, name, kind, platform, token_hash, approved_at)
    VALUES ('phone', 'Otto phone', 'browser', 'iOS', ${TOKEN_HASH}, ${AT})`;
});

/** Memory for the exports (ADR 028): Quill's own, a project's and everyone's, none of it Aldric's. */
const memory = makeMemoryStoreFake();
const YOU = { _tag: "You" } as const;
const SITE = memoryProjectIdentity("git@github.com:me/site.git", "site");
const seedMemory = Effect.gen(function* () {
  const store = yield* MemoryStore;
  const page = (path: string, markdown: string) => ({ path: MemoryPath.make(path), markdown, tags: [], pinned: false });
  const fresh = { _tag: "New" } as const;
  yield* store.write(YOU, { _tag: "Everyone" }, page("about-you.md", "# About you\n\nPrefers short PRs."), fresh);
  yield* store.write(
    { _tag: "Hob", agentId: QUILL, projects: [SITE] },
    { _tag: "Hob", agentId: QUILL },
    page("notes/voice.md", `# Voice\n\nWarm, never pushy. Key: ${PASTED}`),
    fresh,
  );
  yield* store.write(
    YOU,
    { _tag: "Project", identity: SITE },
    page("facts/deploy.md", "# Deploy\n\nFridays only."),
    fresh,
  );
});

const App = DataExport.layer("9.9.9").pipe(
  Layer.provideMerge(Layer.effectDiscard(Effect.andThen(seed, seedMemory))),
  Layer.provideMerge(Layer.succeed(MemoryStore, memory.store)),
  Layer.provideMerge(
    Layer.mergeAll(
      HobFilesLive,
      ExportFoldersLive,
      SaveDestinationsLive(workspace),
      SecretRedaction.layer([{ value: HUB_SECRET, kind: "HUB_TOKEN" }]),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      HobbotsRepositoryLive,
      TaskRepositoryLive,
      ActivityRepositoryLive,
      SetupRepository.layer,
      EventJournal.layer,
      EventBus.layer,
      NodeFolderChecks,
    ),
  ),
  Layer.provideMerge(TestDatabase),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;
beforeAll(async () => {
  mkdirSync(project, { recursive: true });
  mkdirSync(saved, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(project, "report.md"), REPORT);
  writeFileSync(join(project, "chart #1.png"), PNG);
  writeFileSync(join(project, "dump.bin"), DUMP);
  writeFileSync(join(project, ".env"), `API_TOKEN=${HUB_SECRET}\n`);
  runtime = ManagedRuntime.make(App);
  await runtime.runPromise(Effect.void);
});
afterAll(() => runtime.dispose());

const run = (scope: ExportScope, destination = saved) =>
  runtime.runPromise(DataExport.use((exporter) => exporter.run(scope, destination)));
const refusal = (scope: ExportScope, destination = saved) =>
  runtime.runPromise(DataExport.use((exporter) => Effect.flip(exporter.run(scope, destination))));

/** Every file in `folder`, by its path inside it. */
const filesIn = (folder: string): Record<string, Buffer> =>
  Object.fromEntries(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(folder, path), readFileSync(path)];
      }),
  );

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(HobbotsExport));

/** The records of Aldric's export: its hobs and threads, the Quest with Quill's Task as a summary, and the work history. */
const expectRecords = (data: HobbotsExport) => {
  expect(data).toMatchObject({ format: "hobbots.export", version: 1, hobbotsVersion: "9.9.9" });
  expect(data.hobs.map((each) => [each.name, each.roleTitle, each.runtime])).toEqual([
    ["Aldric", "Marketing", "claude-code"],
    ["Quill", "Marketing", "claude-code"],
  ]);
  expect(data.threads.map((thread) => thread.title)).toEqual(["Black Friday campaign", "Notes / ideas"]);
  const [tree] = data.quests;
  // Quill's Quest is Quill's: its goal and state only.
  expect(tree?.quests.map((quest) => [quest.goal, quest.detail, quest.acceptance])).toEqual([
    ["A Black Friday campaign", "full", ["Copy approved"]],
    ["Copy for every channel", "summary", []],
  ]);
  // Aldric's Task in full; Quill's as its title and state only.
  expect(tree?.tasks.map((task) => [task.title, task.detail, task.state])).toEqual([
    ["Run the Black Friday campaign", "full", "completed"],
    ["Draft the copy", "summary", "cancelled"],
  ]);
  const top = tree?.tasks[0];
  expect(top?.result).toBe("Campaign ready");
  const artifacts = top?.artifacts.map((artifact) => [artifact.label, artifact.copiedTo, artifact.notCopied]);
  expect(artifacts?.sort()).toEqual([
    ["Chart", "files/campaign-task/chart #1.png", null],
    ["Dump", null, "holds-secret"],
    ["Old draft", null, "gone"],
    ["Settings", null, "secret"],
    ["Store", null, null],
    ["The report", "files/campaign-task/report.md", null],
  ]);
  expect(top?.attempts[0]?.commands.map((command) => [command.command, command.exitCode])).toEqual([["pnpm build", 0]]);
  expect(top?.attempts[0]?.changes.map((change) => [change.path, change.kind])).toEqual([["report.md", "added"]]);
};

/** The Markdown of Aldric's export, which a person reads without Hobbots. */
const expectMarkdown = (files: Record<string, Buffer>) => {
  const quest = files["quests/2026-11-02 A Black Friday campaign.md"]?.toString() ?? "";
  expect(quest).toContain("## Quest: A Black Friday campaign");
  expect(quest).toContain("[files/campaign-task/report.md](../files/campaign-task/report.md)");
  // A `#` in a file's name is part of the link's path, not a fragment.
  expect(quest).toContain("[files/campaign-task/chart #1.png](../files/campaign-task/chart%20%231.png)");
  expect(quest).toContain("not copied because it holds what looks like a secret");
  expect(quest).toContain("_Another hob's Quest: only its goal and state are exported._");
  expect(quest).toContain("- File “Old draft”: `draft.md`, not copied because it is no longer there");
  expect(quest).toContain("not copied because its name marks it as a file that may hold secrets");
  expect(quest).toContain("Ran `pnpm build`");
  expect(quest).toContain("### Draft the copy");
  const thread = files["threads/2026-11-02 Black Friday campaign.md"]?.toString() ?? "";
  expect(thread).toContain("**You** · 2026-11-02 10:00 UTC");
  expect(thread).toContain("**Aldric** · 2026-11-02 11:00 UTC");
  expect(thread).toContain("- Running pnpm test: done");
};

describe("exports", () => {
  // covers OP-003
  it("[TC-OP-040] an export of a hob opens on its own and holds its threads, Quests, artifacts and work history", async () => {
    const result = await run({ _tag: "Hob", agentId: ALDRIC });
    expect(result.folder.startsWith(join(saved, "Hobbots export Aldric "))).toBe(true);
    expect(result).toMatchObject({ threads: 2, quests: 1, files: 2, notCopied: 3 });

    const files = filesIn(result.folder);
    expect(Object.keys(files).sort()).toEqual([
      "README.md",
      "export.json",
      "files/campaign-task/chart #1.png",
      "files/campaign-task/report.md",
      "quests/2026-11-02 A Black Friday campaign.md",
      "threads/2026-11-02 Black Friday campaign.md",
      "threads/2026-11-02 Notes ideas.md",
    ]);
    // A text file is redacted like any other string; a binary one with no secret is copied as it is.
    expect(files["files/campaign-task/report.md"]?.toString()).toBe(REPORT.replace(PASTED, "[redacted: GitHub token]"));
    expect(new Uint8Array(files["files/campaign-task/chart #1.png"] ?? [])).toEqual(PNG);

    expectRecords(decode(files["export.json"]?.toString()));
    expectMarkdown(files);
    expect(files["README.md"]?.toString()).toContain("Redaction is best effort");
  });

  // covers OP-003
  it("[TC-OP-041] redacts every string, your own messages included, and holds no device record, token hash or other hob's brief", async () => {
    const result = await run({ _tag: "Hob", agentId: ALDRIC });
    // The copied files included: what the Tasks made is redacted too.
    const text = Object.values(filesIn(result.folder))
      .map((bytes) => bytes.toString("latin1"))
      .join("\n");
    expect(text).not.toContain(PASTED);
    expect(text).not.toContain(HUB_SECRET);
    expect(text).toContain("[redacted: GitHub token]");
    expect(text).toContain("[redacted: HUB_TOKEN]");
    // Nothing of the device, and no hob's instructions.
    expect(text).not.toContain(TOKEN_HASH);
    expect(text).not.toContain("Otto phone");
    expect(text).not.toContain("Use [redacted");
    // Quill's brief is Quill's: Aldric's export names its Task only.
    expect(text).not.toContain("secret discount");
    expect(text).not.toContain("Quill's private acceptance");
    // A file named as one that may hold secrets is never copied.
    expect(existsSync(join(result.folder, "files", "campaign-task", ".env"))).toBe(false);
  });

  // covers OP-003
  it("[TC-OP-042] exports one thread, or everything, and never writes over an earlier export", async () => {
    const thread = await run({ _tag: "Thread", threadId: CAMPAIGN });
    const threadData = decode(readFileSync(join(thread.folder, "export.json"), "utf8"));
    expect(threadData.threads.map((each) => each.title)).toEqual(["Black Friday campaign"]);
    // In a thread's export every Task of its Quests is in full.
    expect(threadData.quests[0]?.tasks.map((task) => task.detail)).toEqual(["full", "full"]);
    expect(JSON.stringify(threadData)).toContain("secret discount");

    const everything = await run({ _tag: "Everything" });
    const everythingData = decode(readFileSync(join(everything.folder, "export.json"), "utf8"));
    expect(everythingData.threads.map((each) => each.title).sort()).toEqual([
      "Black Friday campaign",
      "Notes / ideas",
      "Quill's own chat",
    ]);
    expect(everythingData.hobs.map((each) => each.name)).toEqual(["Aldric", "Quill"]);

    const again = await run({ _tag: "Everything" });
    expect(again.folder).toBe(`${everything.folder} (2)`);
  });

  // covers OP-003
  it("[TC-OP-043] refuses a destination inside a hob's folder, or one that is not a folder, and writes nothing", async () => {
    const before = readdirSync(project).sort();
    const inside = await refusal({ _tag: "Everything" }, join(project));
    expect(inside._tag).toBe("InvalidFolder");
    expect(readdirSync(project).sort()).toEqual(before);
    const inWorkspace = await refusal({ _tag: "Everything" }, workspace);
    expect(inWorkspace._tag).toBe("InvalidFolder");
    const missing = await refusal({ _tag: "Everything" }, join(temp, "nowhere"));
    expect(missing._tag).toBe("InvalidFolder");
    const relativePath = await refusal({ _tag: "Everything" }, "saved");
    expect(relativePath._tag).toBe("InvalidFolder");
  });

  // covers OP-003
  it("[TC-OP-044] refuses a hob or thread that is not there", async () => {
    expect((await refusal({ _tag: "Hob", agentId: AgentId.make("nobody") }))._tag).toBe("AgentNotFound");
    expect((await refusal({ _tag: "Thread", threadId: ThreadId.make("nothing") }))._tag).toBe("ThreadNotFound");
  });

  // covers OP-003, ADR 028 (Backups)
  it("[TC-OP-100] exports each memory scope's pages as redacted Markdown, a hob's own with its export, and says when memory is down", async () => {
    const everything = await run({ _tag: "Everything" });
    const files = filesIn(everything.folder);
    expect(
      Object.keys(files)
        .filter((path) => path.startsWith("memory/"))
        .sort(),
    ).toEqual([
      "memory/everyone/about-you.md",
      "memory/hobs/Quill/notes/voice.md",
      "memory/projects/github.com me site/facts/deploy.md",
    ]);
    expect(files["memory/everyone/about-you.md"]?.toString()).toBe("# About you\n\nPrefers short PRs.");
    expect(files["memory/hobs/Quill/notes/voice.md"]?.toString()).toBe(
      "# Voice\n\nWarm, never pushy. Key: [redacted: GitHub token]",
    );
    const data = decode(files["export.json"]?.toString());
    expect(data.memory.state).toBe("included");
    expect(data.memory.pages.map((page) => [page.scope._tag, page.path, page.title, page.file])).toEqual([
      ["Everyone", "about-you.md", "About you", "memory/everyone/about-you.md"],
      ["Hob", "notes/voice.md", "Voice", "memory/hobs/Quill/notes/voice.md"],
      ["Project", "facts/deploy.md", "Deploy", "memory/projects/github.com me site/facts/deploy.md"],
    ]);
    expect(data.memory.pages[1]?.author).toEqual({ _tag: "Hob", agentId: QUILL });
    expect(files["README.md"]?.toString()).toContain("`memory/`: 3 pages your hobs remember");

    // A hob's export holds its own memory only; a thread's holds none.
    const quill = filesIn((await run({ _tag: "Hob", agentId: QUILL })).folder);
    expect(Object.keys(quill).filter((path) => path.startsWith("memory/"))).toEqual([
      "memory/hobs/Quill/notes/voice.md",
    ]);
    const thread = decode(
      filesIn((await run({ _tag: "Thread", threadId: CAMPAIGN })).folder)["export.json"]?.toString(),
    );
    expect(thread.memory).toEqual({ state: "none", pages: [] });

    // Memory that does not answer leaves the rest of the export as it is.
    memory.controls.setDown(true);
    try {
      const down = filesIn((await run({ _tag: "Everything" })).folder);
      expect(Object.keys(down).some((path) => path.startsWith("memory/"))).toBe(false);
      expect(decode(down["export.json"]?.toString()).memory.state).toBe("unavailable");
      expect(down["README.md"]?.toString()).toContain("memory did not answer");
      expect(Object.keys(down)).toContain("threads/2026-11-02 Black Friday campaign.md");
    } finally {
      memory.controls.setDown(false);
    }
  });
});
