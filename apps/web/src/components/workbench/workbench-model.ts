import {
  type Attempt,
  type AttemptActivity,
  type AttemptId,
  isLiveAttempt,
  type ScanStop,
  type Task,
  type TaskTree,
} from "@hobbots/domain";
import { Schema } from "effect";

/** The Workbench's tabs, in their order (ADR 023). Summary is the one it opens on. */
export const WORKBENCH_TABS = ["summary", "changes", "files", "terminal", "browser"] as const;
export const WorkbenchTab = Schema.Literals(WORKBENCH_TABS);
export type WorkbenchTab = typeof WorkbenchTab.Type;

export const isWorkbenchTab = Schema.is(WorkbenchTab);

/** Why a tab's records cannot be shown: cleared past the window, or a folder no longer tracked. */
export type UnavailableReason = "cleared" | ScanStop | "unread";

/**
 * Each tab's one honest label, taken from the hub's records (ADR 023): Live while the chosen
 * Attempt runs, History once it does not, Unavailable with why, Not used in this task, and Coming
 * soon for the Browser.
 */
export type TabState =
  | { readonly kind: "live" }
  | { readonly kind: "history" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }
  | { readonly kind: "not-used" }
  | { readonly kind: "coming-soon" };

export type TabStates = Readonly<Record<WorkbenchTab, TabState>>;

/**
 * What the Workbench knows of the chosen Attempt's records: none yet while they load, `failed`
 * when the read failed, or the records. A Task with no Attempt has no records at all.
 */
export type ActivityRead = AttemptActivity | "loading" | "failed" | "none";

const LIVE = { kind: "live" } as const;
const HISTORY = { kind: "history" } as const;
const NOT_USED = { kind: "not-used" } as const;
const unavailable = (reason: UnavailableReason) => ({ kind: "unavailable", reason }) as const;

/** Why change tracking stopped for one of the folders, from the latest scan of each folder. */
const stoppedScan = (activity: AttemptActivity): ScanStop | null => {
  const latest = new Map<string, AttemptActivity["scans"][number]>();
  for (const scan of activity.scans) latest.set(scan.folder, scan);
  for (const scan of latest.values()) if (scan.stopped !== null) return scan.stopped;
  return null;
};

/** The files a Task made or touched: its file Artifact references and every file still there after a change. */
const touchedFiles = (activity: AttemptActivity): number =>
  activity.artifacts.filter((each) => each.kind === "file").length +
  activity.changes.filter((each) => each.after !== null && each.kind !== "link").length;

/**
 * The label of each tab. While the Attempt runs a tab may still be used, so it is Live; once it
 * ends, a tab with no record reads Not used in this task. A folder whose tracking stopped makes
 * Changes Unavailable with why, and details cleared past the window make Changes and Terminal
 * Unavailable while their lists stay. `elsewhere` counts the commands the other hobs in the tree
 * ran, which the Terminal replays beside the Task's own (#908).
 */
export const tabStates = (attempt: Attempt | null, read: ActivityRead, elsewhere = 0): TabStates => {
  const running = attempt !== null && isLiveAttempt(attempt.state);
  const shown: TabState = running ? LIVE : HISTORY;
  const base = { summary: shown, browser: { kind: "coming-soon" } } as const;
  if (read === "none") return { ...base, changes: NOT_USED, files: NOT_USED, terminal: NOT_USED };
  if (read === "loading") return { ...base, changes: shown, files: shown, terminal: shown };
  if (read === "failed") {
    const unread = unavailable("unread");
    return { ...base, changes: unread, files: unread, terminal: unread };
  }
  const used = (count: number): TabState => (count > 0 || running ? shown : NOT_USED);
  const stopped = stoppedScan(read);
  const cleared = read.detailsClearedAt !== null;
  const changes =
    stopped !== null
      ? unavailable(stopped)
      : cleared && read.changes.length > 0
        ? unavailable("cleared")
        : used(read.changes.length);
  const files = stopped !== null && touchedFiles(read) === 0 ? unavailable(stopped) : used(touchedFiles(read));
  const terminal =
    cleared && read.commands.length > 0 ? unavailable("cleared") : used(read.commands.length + elsewhere);
  return { ...base, changes, files, terminal };
};

/** The Task's Attempts, first to last. */
export const attemptsOf = (tree: TaskTree, task: Task): ReadonlyArray<Attempt> =>
  tree.attempts.filter((each) => each.taskId === task.id).sort((a, b) => a.number - b.number);

/** What the Workbench has read of an Attempt's records so far: `unread` before any read. */
export type ProbedRead = AttemptActivity | "unread" | "failed";

/** Whether the Task's own records name the Attempt: a report its owner made, a reference or the result. */
const recordedInTree = (tree: TaskTree, task: Task, attempt: Attempt): boolean =>
  task.result?.attemptId === attempt.id ||
  tree.artifacts.some((each) => each.taskId === task.id && each.attemptId === attempt.id) ||
  tree.checkpoints.some(
    (each) => each.taskId === task.id && each.source !== "automatic" && each.attemptId === attempt.id,
  );

const recordedIn = (activity: AttemptActivity): boolean =>
  activity.commands.length > 0 || activity.changes.length > 0 || activity.artifacts.length > 0;

/**
 * The Attempt the Workbench opens on when none is chosen: the latest that recorded work, so a
 * retry that ended before doing anything does not hide the one that did (#386). A running Attempt,
 * or one whose stop was never confirmed, is shown whatever it recorded. An Attempt whose records
 * are not read yet is the one to read next and is shown meanwhile; one whose read failed is shown,
 * so it reads Unavailable rather than being passed over. With none that recorded anything, the
 * Task's current Attempt, else its latest.
 */
export const openingAttempt = (
  tree: TaskTree,
  task: Task,
  attempts: ReadonlyArray<Attempt>,
  readOf: (attempt: Attempt) => ProbedRead,
): Attempt | null => {
  for (const attempt of attempts.toReversed()) {
    if (isLiveAttempt(attempt.state) || attempt.state === "unresolved" || recordedInTree(tree, task, attempt)) {
      return attempt;
    }
    const read = readOf(attempt);
    if (typeof read !== "object" || recordedIn(read)) return attempt;
  }
  return attempts.find((each) => each.id === task.currentAttemptId) ?? attempts.at(-1) ?? null;
};

/** The Attempt the Workbench shows: the one chosen, else the one it opens on. */
export const chosenAttempt = (
  attempts: ReadonlyArray<Attempt>,
  chosen: AttemptId | undefined,
  opening: () => Attempt | null,
): Attempt | null => attempts.find((each) => each.id === chosen) ?? opening();

/**
 * Who asked for the Task, as a chain from you: "You" for the Task you asked for, then each owner
 * above it that is not its own, so a member's Task reads You → Aldric. Steps share their parent's
 * owner, so a hob is named once however many steps it took.
 */
export const askedBy = (tree: TaskTree, task: Task): ReadonlyArray<Task["ownerId"]> => {
  const chain: Array<Task["ownerId"]> = [];
  let parentId = task.parentId;
  while (parentId !== null) {
    const parent = tree.tasks.find((each) => each.id === parentId);
    if (parent === undefined) break;
    if (parent.ownerId !== task.ownerId && chain[0] !== parent.ownerId) chain.unshift(parent.ownerId);
    parentId = parent.parentId;
  }
  return chain;
};
