import {
  ArtifactId,
  ArtifactRef,
  Attempt,
  AttemptActivity,
  AttemptId,
  Checkpoint,
  CommandId,
  CommandRecord,
  FileChange,
  FileChangeId,
  FolderScan,
  FolderScanId,
  Task,
  TaskId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  attempt,
  BUILD,
  blackFriday,
  CAMPAIGN,
  checkpoint,
  QUILL,
  task,
  tree,
} from "../../test/quests.ts";
import { askedBy, attemptsOf, chosenAttempt, openingAttempt, type ProbedRead, tabStates } from "./workbench-model.ts";

const AT = "2026-11-01T10:00:00.000Z";
const done = attempt(CAMPAIGN, "completed");
const running = attempt(CAMPAIGN, "running");

const command = (fields: Partial<{ sandboxed: boolean }> = {}) =>
  new CommandRecord({
    id: CommandId.make("c1"),
    attemptId: done.id,
    taskId: CAMPAIGN,
    stepId: "step-1",
    command: "npm run format",
    folder: "/work",
    sandboxed: fields.sandboxed ?? true,
    liveOutput: false,
    state: "succeeded",
    exitCode: 0,
    startedAt: AT,
    endedAt: AT,
    output: null,
    log: null,
    logNotKept: null,
  });

const change = (kind: FileChange["kind"]) =>
  new FileChange({
    id: FileChangeId.make(`f-${kind}`),
    attemptId: done.id,
    taskId: CAMPAIGN,
    folder: "/work",
    path: "notes.md",
    kind,
    movedFrom: null,
    before: null,
    after: kind === "deleted" ? null : { hash: "h", size: 3, kind: "text", contentId: null, notKept: null },
    sharedWith: [],
    settled: true,
    recordedAt: AT,
  });

const scan = (stopped: FolderScan["stopped"], phase: FolderScan["phase"] = "end") =>
  new FolderScan({
    id: FolderScanId.make(`s-${phase}`),
    attemptId: done.id,
    taskId: CAMPAIGN,
    folder: "/work",
    phase,
    filesScanned: 3,
    stopped,
    startedAt: AT,
    endedAt: AT,
  });

const activity = (fields: Partial<ConstructorParameters<typeof AttemptActivity>[0]> = {}) =>
  new AttemptActivity({
    attempt: done,
    commands: [],
    changes: [],
    scans: [scan(null, "start"), scan(null)],
    artifacts: [],
    sharedWithHobs: [],
    detailsClearedAt: null,
    ...fields,
  });

describe("the Workbench's tab labels", () => {
  it("reads History for a finished Task, Not used for each tab it has no record for, and Coming soon for the Browser", () => {
    expect(tabStates(done, activity({ changes: [change("edited")] }))).toEqual({
      changes: { kind: "history" },
      files: { kind: "history" },
      terminal: { kind: "not-used" },
      browser: { kind: "coming-soon" },
    });
  });

  it("keeps every tab Live while the Attempt runs, since it may still use them", () => {
    const states = tabStates(running, activity({ attempt: running }));
    expect([states.changes, states.files, states.terminal]).toEqual(Array(3).fill({ kind: "live" }));
    expect(states.browser).toEqual({ kind: "coming-soon" });
  });

  it("counts a file the Task made as used in Files even when it changed nothing, and a deleted file only in Changes", () => {
    const made = new ArtifactRef({
      id: ArtifactId.make("a1"),
      taskId: CAMPAIGN,
      attemptId: done.id,
      kind: "file",
      label: "Plan",
      value: "/work/plan.md",
      createdAt: AT,
    });
    expect(tabStates(done, activity({ artifacts: [made] })).files).toEqual({ kind: "history" });
    const deleted = tabStates(done, activity({ changes: [change("deleted")] }));
    expect([deleted.changes, deleted.files]).toEqual([{ kind: "history" }, { kind: "not-used" }]);
  });

  it("says why Changes is Unavailable when a folder stopped being tracked", () => {
    const states = tabStates(done, activity({ scans: [scan(null, "start"), scan("too-many-files")] }));
    expect(states.changes).toEqual({ kind: "unavailable", reason: "too-many-files" });
    expect(states.files).toEqual({ kind: "unavailable", reason: "too-many-files" });
  });

  it("reads Unavailable for cleared details while their lists stay, and Not used where nothing was recorded", () => {
    const states = tabStates(done, activity({ commands: [command()], detailsClearedAt: AT }));
    expect(states.terminal).toEqual({ kind: "unavailable", reason: "cleared" });
    expect(states.changes).toEqual({ kind: "not-used" });
  });

  it("reads Not used for every tab of a Task with no Attempt, and Unavailable when its records could not be read", () => {
    const none = tabStates(null, "none");
    expect([none.changes, none.files, none.terminal]).toEqual([
      { kind: "not-used" },
      { kind: "not-used" },
      { kind: "not-used" },
    ]);
    expect(tabStates(done, "failed").terminal).toEqual({ kind: "unavailable", reason: "unread" });
    expect(tabStates(done, "loading").changes).toEqual({ kind: "history" });
  });
});

describe("the Workbench's Attempt", () => {
  const second = new Attempt({ ...done, id: AttemptId.make("a-2"), number: 2, state: "failed" });
  const third = new Attempt({ ...done, id: AttemptId.make("a-3"), number: 3, state: "running" });
  const campaign = (current: AttemptId | null): Task => new Task({ ...task(CAMPAIGN), currentAttemptId: current });

  const first = new Attempt({ ...done, state: "failed" });
  const empty = activity({ scans: [] });
  const readOf =
    (reads: Readonly<Record<string, ProbedRead>>) =>
    (each: Attempt): ProbedRead =>
      reads[each.id] ?? "unread";

  it("lists a Task's Attempts first to last and shows the one chosen over the one it opens on", () => {
    const withAttempts = tree({ attempts: [third, attempt(BUILD, "running"), done, second] });
    const attempts = attemptsOf(withAttempts, campaign(null));
    expect(attempts.map((each) => each.number)).toEqual([1, 2, 3]);
    expect(chosenAttempt(attempts, done.id, () => third)?.number).toBe(1);
    expect(chosenAttempt(attempts, undefined, () => second)?.number).toBe(2);
    expect(chosenAttempt([], undefined, () => null)).toBeNull();
  });

  it("opens on the latest Attempt that recorded work, passing over retries that recorded nothing", () => {
    const attempts = [first, second];
    const records = tree({ attempts });
    const opening = (reads: Readonly<Record<string, ProbedRead>>) =>
      openingAttempt(records, campaign(second.id), attempts, readOf(reads))?.number;
    // Nothing read yet: the newest is the one to read, and it shows meanwhile.
    expect(opening({})).toBe(2);
    expect(opening({ [second.id]: empty })).toBe(1);
    expect(opening({ [second.id]: empty, [first.id]: activity({ commands: [command()] }) })).toBe(1);
    // A read that failed is shown, so its tabs read Unavailable rather than being skipped.
    expect(opening({ [second.id]: "failed" })).toBe(2);
    expect(opening({ [second.id]: activity({ changes: [change("edited")] }) })).toBe(2);
    // With none that recorded anything, the Task's current Attempt.
    expect(opening({ [second.id]: empty, [first.id]: empty })).toBe(2);
    expect(openingAttempt(records, campaign(first.id), attempts, () => empty)?.number).toBe(1);
    expect(openingAttempt(tree({}), campaign(null), [], () => empty)).toBeNull();
  });

  it("shows a running Attempt, an unconfirmed stop and one the Task's records name without reading them", () => {
    const unresolved = new Attempt({ ...second, state: "unresolved" });
    const never = () => {
      throw new Error("read");
    };
    expect(openingAttempt(tree({}), campaign(null), [first, third], never)?.number).toBe(3);
    expect(openingAttempt(tree({}), campaign(null), [first, unresolved], never)?.number).toBe(2);
    const reported = new Checkpoint({ ...checkpoint(CAMPAIGN, "finding", "Prices change", 4), attemptId: second.id });
    const automatic = new Checkpoint({ ...checkpoint(CAMPAIGN, "started", "", 5), attemptId: second.id });
    expect(openingAttempt(tree({ checkpoints: [reported] }), campaign(null), [first, second], never)?.number).toBe(2);
    expect(
      openingAttempt(
        tree({ checkpoints: [automatic] }),
        campaign(null),
        [first, second],
        readOf({ [second.id]: empty }),
      )?.number,
    ).toBe(1);
    const resulted = new Task({ ...campaign(null), result: { summary: "Done", attemptId: second.id } });
    expect(openingAttempt(tree({}), resulted, [first, second], never)?.number).toBe(2);
  });
});

describe("who asked for a Task", () => {
  it("is you for the Task you asked for, and you then each lead above a member's Task", () => {
    const bf = blackFriday();
    const find = (id: TaskId) => bf.tasks.find((each) => each.id === id) as Task;
    expect(askedBy(bf, find(CAMPAIGN))).toEqual([]);
    expect(askedBy(bf, find(BUILD))).toEqual([ALDRIC]);
    // A step under Ada's Task, and a Task Quill took under it: Ada is named once, after Aldric.
    const step = task(TaskId.make("step"), { ownerId: ADA, parentId: BUILD });
    const deeper = task(TaskId.make("deeper"), { ownerId: QUILL, parentId: step.id });
    const nested = tree({ ...bf, tasks: [...bf.tasks, step, deeper] });
    expect(askedBy(nested, step)).toEqual([ALDRIC]);
    expect(askedBy(nested, deeper)).toEqual([ALDRIC, ADA]);
  });
});
