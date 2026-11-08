import type {
  AgentId,
  Attempt,
  AttemptActivity,
  AttemptId,
  Task,
  TaskFile,
  TaskId,
  TaskTree,
  TreeActivity,
  TreeAttempt,
} from "@hobbots/domain";
import { type TaskChange, taskChanges } from "./changes/task-changes.ts";
import {
  attemptsOf,
  chosenAttempt,
  openingAttempt,
  type TabState,
  type TabStates,
  tabStates,
  type WorkbenchTab,
} from "./workbench-model.ts";

/**
 * The docked Workbench of a whole Quest (ADR 027): one list of every hob's work, read in one call
 * for the tree, filtered by the lane you picked and the try you picked in it.
 */

/** A file a try made or touched, with the records of that try, through which it is read. */
interface TriedFile {
  readonly file: TaskFile;
  readonly activity: AttemptActivity;
}

/**
 * One Task's Attempt as the dock shows it: what it ran, changed and made, and the hob it is for. A
 * retry works on what the tries before it left, so its changes and files are those of the Task's
 * tries up to the shown one, taken as one (#1218); its commands are its own.
 */
export interface DockSource {
  readonly task: Task;
  readonly attempt: Attempt;
  /** The hob that owns the Task now, whose lane and sprite the work shows under. */
  readonly ownerId: AgentId;
  readonly activity: AttemptActivity;
  /** Each file the Task's tries up to the shown one changed, as they left it. */
  readonly changes: ReadonlyArray<TaskChange>;
  /** Each file those tries made or touched, once, as the latest of them that lists it reads it. */
  readonly files: ReadonlyArray<TriedFile>;
}

/** Whose work the dock narrows to: a lit lane's hob, or the one Task shown in it. */
export type DockFilter = { readonly ownerId: AgentId } | { readonly taskId: TaskId };

const inFilter = (only: DockFilter, task: Task): boolean =>
  "taskId" in only ? task.id === only.taskId : task.ownerId === only.ownerId;

/**
 * The Attempt the dock shows for each Task in the tree, in tree order: the try picked in a lane for
 * its own Task, else the latest that recorded work (#386). Narrowed to a hob's Tasks when its lane is
 * lit, or to one Task when it alone was shown. A Task with no Attempt yet, or one the read does not
 * hold yet, has none.
 */
export const dockSources = (
  tree: TaskTree,
  read: TreeActivity,
  chosen: AttemptId | undefined,
  only: DockFilter | undefined,
): ReadonlyArray<DockSource> => {
  const byAttempt = new Map(read.attempts.map((each) => [each.activity.attempt.id, each]));
  return tree.tasks.flatMap((task) => {
    if (only !== undefined && !inFilter(only, task)) return [];
    const attempts = attemptsOf(tree, task);
    const shown = chosenAttempt(attempts, chosen, () =>
      openingAttempt(tree, task, attempts, (each) => byAttempt.get(each.id)?.activity ?? "unread"),
    );
    const found = shown === null ? undefined : byAttempt.get(shown.id);
    if (shown === null || found === undefined) return [];
    const tries = attempts.flatMap((each) => {
      const read = byAttempt.get(each.id);
      return read === undefined || each.number > shown.number ? [] : [read];
    });
    return [
      {
        task,
        attempt: shown,
        ownerId: found.ownerId,
        activity: found.activity,
        changes: taskChanges(tries.map((each) => each.activity)),
        files: triedFiles(tries),
      },
    ];
  });
};

/** The files of a Task's tries, first to last: each once, at the latest try that lists it. */
const triedFiles = (tries: ReadonlyArray<TreeAttempt>): ReadonlyArray<TriedFile> => {
  const byLocation = new Map<string, TriedFile>();
  for (const { activity, files } of tries) {
    for (const file of files) {
      byLocation.delete(file.location);
      byLocation.set(file.location, { file, activity });
    }
  }
  return [...byLocation.values()];
};

/** A tab that lists records: every tab but the Browser, which has none yet (#382). */
export type ListTab = Exclude<WorkbenchTab, "browser">;

/** How many records each tab lists, the counts on the folded strip. */
export const dockCounts = (sources: ReadonlyArray<DockSource>): Readonly<Record<ListTab, number>> => ({
  changes: sources.reduce((sum, each) => sum + each.changes.length, 0),
  files: sources.reduce((sum, each) => sum + each.files.length, 0),
  terminal: sources.reduce((sum, each) => sum + each.activity.commands.length, 0),
});

/** One hob's label for a tab (ADR 023): Live, History, Unavailable with why, or Not used. */
export interface HobTabState {
  readonly ownerId: AgentId;
  readonly state: TabState;
}

/** Which label says the most: why a tab cannot be shown, then that it is live, then its history. */
const RANK: Readonly<Record<TabState["kind"], number>> = {
  unavailable: 3,
  live: 2,
  history: 1,
  "not-used": 0,
  "coming-soon": 0,
};

const HISTORY: TabState = { kind: "history" };

/**
 * A Task's label for a tab, from the try shown. Changes and Files hold the earlier tries' work too,
 * so a retry that changed nothing itself still reads History on them when an earlier try did (#1218).
 */
const tryState = (source: DockSource, tab: ListTab): TabState => {
  const state = tabStates(source.attempt, source.activity)[tab];
  const earlier = tab === "changes" ? source.changes.length : tab === "files" ? source.files.length : 0;
  return state.kind === "not-used" && earlier > 0 ? HISTORY : state;
};

const telling = (a: TabState, b: TabState): TabState => (RANK[b.kind] > RANK[a.kind] ? b : a);

/** Each hob's label for a tab, the most telling of its Tasks', hobs in the order their work shows. */
export const hobStates = (sources: ReadonlyArray<DockSource>, tab: ListTab): ReadonlyArray<HobTabState> => {
  const byHob = new Map<AgentId, TabState>();
  for (const source of sources) {
    const state = tryState(source, tab);
    const known = byHob.get(source.ownerId);
    byHob.set(source.ownerId, known === undefined ? state : telling(known, state));
  }
  return [...byHob].map(([ownerId, state]) => ({ ownerId, state }));
};

const NOT_USED: TabState = { kind: "not-used" };

/**
 * Each tab's one mark on the strip: Unavailable when a hob's records for it cannot be shown, Live
 * while a hob may still use it, History once one did, and Not used when no hob in view did.
 */
export const dockStates = (sources: ReadonlyArray<DockSource>): TabStates => {
  const of = (tab: ListTab) =>
    hobStates(sources, tab).reduce<TabState>((all, each) => telling(all, each.state), NOT_USED);
  return { changes: of("changes"), files: of("files"), terminal: of("terminal"), browser: { kind: "coming-soon" } };
};

/** Every tab with the same label, while the read is on its way or after it failed. */
export const sameStates = (state: TabState): TabStates => ({
  changes: state,
  files: state,
  terminal: state,
  browser: { kind: "coming-soon" },
});
