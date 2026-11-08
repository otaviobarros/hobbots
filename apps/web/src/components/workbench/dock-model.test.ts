import {
  Attempt,
  AttemptActivity,
  AttemptId,
  CommandId,
  CommandRecord,
  FileChange,
  FileChangeId,
  FolderScan,
  FolderScanId,
  TaskFile,
  TaskFileId,
  type TaskId,
  TreeActivity,
  TreeAttempt,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ADA, ALDRIC, attempt, BUILD, CAMPAIGN, COPY, QUILL, task, tree } from "../../test/quests.ts";
import { dockCounts, dockSources, dockStates, hobStates } from "./dock-model.ts";

const AT = "2026-11-01T10:00:00.000Z";

const tryOf = (taskId: TaskId, number: number, state: Attempt["state"]): Attempt =>
  new Attempt({ ...attempt(taskId, state), id: AttemptId.make(`a-${taskId}-${number}`), number });

const change = (of: Attempt, path: string) =>
  new FileChange({
    id: FileChangeId.make(`f-${of.id}-${path}`),
    attemptId: of.id,
    taskId: of.taskId,
    folder: "/work",
    path,
    kind: "added",
    movedFrom: null,
    before: null,
    after: { hash: "h", kind: "text", size: 4, contentId: null, notKept: null },
    sharedWith: [],
    settled: true,
    recordedAt: AT,
  });

const command = (of: Attempt) =>
  new CommandRecord({
    id: CommandId.make(`c-${of.id}`),
    attemptId: of.id,
    taskId: of.taskId,
    stepId: "step",
    command: "ls",
    folder: "/work",
    sandboxed: true,
    liveOutput: false,
    state: "succeeded",
    exitCode: 0,
    startedAt: AT,
    endedAt: AT,
    output: null,
    log: null,
    logNotKept: null,
  });

const file = (of: Attempt, path: string) =>
  new TaskFile({
    id: TaskFileId.make(`file-${of.id}-${path}`),
    folder: "/work",
    path,
    location: `/work/${path}`,
    label: null,
    origin: "added",
    preview: "text",
    size: 4,
    now: "same",
    hash: null,
    notServed: null,
  });

const recorded = (
  of: Attempt,
  ownerId: typeof ALDRIC,
  fields: Partial<{ changes: Array<FileChange>; commands: Array<CommandRecord>; files: Array<TaskFile> }> & {
    scans?: Array<FolderScan>;
  } = {},
) =>
  new TreeAttempt({
    ownerId,
    files: fields.files ?? [],
    activity: new AttemptActivity({
      attempt: of,
      commands: fields.commands ?? [],
      changes: fields.changes ?? [],
      scans: fields.scans ?? [],
      artifacts: [],
      sharedWithHobs: [],
      detailsClearedAt: null,
    }),
  });

// Aldric leads; Quill wrote copy on its second try after a first that changed one file; Ada builds.
const lead = tryOf(CAMPAIGN, 1, "running");
const copyFirst = tryOf(COPY, 1, "failed");
const copySecond = tryOf(COPY, 2, "completed");
const build = tryOf(BUILD, 1, "running");
const quest = tree({
  tasks: [task(CAMPAIGN), task(COPY, { ownerId: QUILL }), task(BUILD, { ownerId: ADA })],
  attempts: [lead, copyFirst, copySecond, build],
});
const read = new TreeActivity({
  taskId: CAMPAIGN,
  attempts: [
    recorded(lead, ALDRIC, { commands: [command(lead)] }),
    recorded(copyFirst, QUILL, { changes: [change(copyFirst, "draft.md")], files: [file(copyFirst, "draft.md")] }),
    recorded(copySecond, QUILL, {
      changes: [change(copySecond, "copy.md"), change(copySecond, "notes.md")],
      files: [file(copySecond, "copy.md")],
    }),
    recorded(build, ADA, { changes: [change(build, "page.astro")], commands: [command(build)] }),
  ],
});

describe("the docked Workbench's sources", () => {
  it("shows every hob's latest try, in tree order, and counts what each tab lists, the earlier tries' changes too", () => {
    const sources = dockSources(quest, read, undefined, undefined);
    expect(sources.map((each) => [each.ownerId, each.attempt.id])).toEqual([
      [ALDRIC, lead.id],
      [QUILL, copySecond.id],
      [ADA, build.id],
    ]);
    // Quill's second try works on what her first left: its changes and files hold the first try's draft too (#1218).
    const quill = sources[1];
    expect(quill?.changes.map((each) => [each.change.path, each.activity.attempt.id])).toEqual([
      ["copy.md", copySecond.id],
      ["draft.md", copyFirst.id],
      ["notes.md", copySecond.id],
    ]);
    expect(quill?.files.map((each) => [each.file.path, each.activity.attempt.id])).toEqual([
      ["draft.md", copyFirst.id],
      ["copy.md", copySecond.id],
    ]);
    expect(dockCounts(sources)).toEqual({ changes: 4, files: 2, terminal: 2 });
  });

  it("filters every tab to the lit lane's hob", () => {
    const sources = dockSources(quest, read, undefined, { ownerId: QUILL });
    expect(sources.map((each) => each.attempt.id)).toEqual([copySecond.id]);
    expect(dockCounts(sources)).toEqual({ changes: 3, files: 2, terminal: 0 });
  });

  it("narrows to one Task when it alone was shown", () => {
    const sources = dockSources(quest, read, undefined, { taskId: BUILD });
    expect(sources.map((each) => each.attempt.id)).toEqual([build.id]);
  });

  it("follows an earlier try picked for its Task, and the latest for every other Task", () => {
    const sources = dockSources(quest, read, copyFirst.id, undefined);
    expect(sources.map((each) => each.attempt.id)).toEqual([lead.id, copyFirst.id, build.id]);
    // An earlier try's work stops at it: the tries after it are left out.
    expect(sources[1]?.changes.map((each) => each.change.path)).toEqual(["draft.md"]);
    expect(dockCounts(sources)).toEqual({ changes: 2, files: 1, terminal: 2 });
  });

  it("leaves out a Task whose try the read does not hold yet", () => {
    const later = new TreeActivity({ taskId: CAMPAIGN, attempts: read.attempts.slice(0, 1) });
    expect(dockSources(quest, later, undefined, undefined).map((each) => each.ownerId)).toEqual([ALDRIC]);
  });
});

describe("the docked Workbench's labels", () => {
  it("reads History on Changes for a retry that changed nothing itself after an earlier try did", () => {
    const idle = new TreeActivity({
      taskId: CAMPAIGN,
      attempts: read.attempts.map((each) =>
        each.activity.attempt.id === copySecond.id ? recorded(copySecond, QUILL) : each,
      ),
    });
    const sources = dockSources(quest, idle, copySecond.id, { ownerId: QUILL });
    expect(dockStates(sources)).toMatchObject({
      changes: { kind: "history" },
      files: { kind: "history" },
      terminal: { kind: "not-used" },
    });
  });

  it("keeps each hob's label, and marks a tab by the most telling one", () => {
    const sources = dockSources(quest, read, undefined, undefined);
    expect(hobStates(sources, "changes")).toEqual([
      { ownerId: ALDRIC, state: { kind: "live" } },
      { ownerId: QUILL, state: { kind: "history" } },
      { ownerId: ADA, state: { kind: "live" } },
    ]);
    expect(dockStates(sources)).toMatchObject({ changes: { kind: "live" }, browser: { kind: "coming-soon" } });
  });

  it("reads Not used when no hob in view used a tab, and Unavailable when one hob's folder stopped being tracked", () => {
    const quill = dockSources(quest, read, undefined, { ownerId: QUILL });
    expect(dockStates(quill).terminal).toEqual({ kind: "not-used" });
    const stopped = new FolderScan({
      id: FolderScanId.make("s"),
      attemptId: copySecond.id,
      taskId: COPY,
      folder: "/work",
      phase: "end",
      filesScanned: 0,
      stopped: "too-many-files",
      startedAt: AT,
      endedAt: AT,
    });
    const untracked = new TreeActivity({
      taskId: CAMPAIGN,
      attempts: read.attempts.map((each) =>
        each.activity.attempt.id === copySecond.id
          ? recorded(copySecond, QUILL, { changes: [...each.activity.changes], scans: [stopped] })
          : each,
      ),
    });
    const sources = dockSources(quest, untracked, undefined, undefined);
    expect(dockStates(sources).changes).toEqual({ kind: "unavailable", reason: "too-many-files" });
    expect(hobStates(sources, "changes").map((each) => each.state.kind)).toEqual(["live", "unavailable", "live"]);
  });
});
