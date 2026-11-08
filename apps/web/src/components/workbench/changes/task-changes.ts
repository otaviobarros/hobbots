import type { Attempt, AttemptActivity, FileChange, FileChangeKind, FileVersion } from "@hobbots/domain";

/**
 * A change with the records that keep each of its versions. A version's contents are read through
 * the Attempt that kept it, so a file one try made and a later try edited reads its earlier version
 * from the first try's records and its later one from the last.
 */
export interface KeptChange {
  readonly change: FileChange;
  readonly beforeIn: AttemptActivity;
  readonly afterIn: AttemptActivity;
}

/** One Attempt's own change, both versions kept in its records. */
export const keptIn = (change: FileChange, activity: AttemptActivity): KeptChange => ({
  change,
  beforeIn: activity,
  afterIn: activity,
});

/** A file as a Task's tries left it, from the first try's before to the latest try's after (#1218). */
export interface TaskChange extends KeptChange {
  /** The records of the latest try that changed it: who else worked there, and whether it settled. */
  readonly activity: AttemptActivity;
  /** The tries that changed it, first to last. */
  readonly attempts: ReadonlyArray<Attempt>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a: FileChange, b: FileChange) => compare(a.folder, b.folder) || compare(a.path, b.path);

const keyOf = (folder: string, path: string) => `${folder}\0${path}`;

const kindOf = (before: FileVersion | null, after: FileVersion | null, moved: boolean): FileChangeKind => {
  if (before?.kind === "link" || after?.kind === "link") return "link";
  if (before === null) return "added";
  if (after === null) return "deleted";
  return moved ? "moved" : "edited";
};

/** A later try's change on top of what the earlier tries left at its file, or null when the two undo each other. */
const combine = (earlier: TaskChange, change: FileChange, activity: AttemptActivity): TaskChange | null => {
  const { before } = earlier.change;
  const { after } = change;
  if (before === null && after === null) return null;
  // Where the file was before the first try: a move keeps it, an added file was nowhere.
  const origin = earlier.change.movedFrom ?? earlier.change.path;
  const movedFrom = before !== null && origin !== change.path ? origin : null;
  if (movedFrom === null && before !== null && after !== null && before.hash === after.hash) return null;
  return {
    change: { ...change, kind: kindOf(before, after, movedFrom !== null), movedFrom, before },
    beforeIn: earlier.beforeIn,
    afterIn: activity,
    activity,
    attempts: [...earlier.attempts, activity.attempt],
  };
};

/**
 * What a Task's tries changed, as one list (#1218): each file once, from what it held before the
 * first try that changed it to what the latest try left. A retry works on what the tries before it
 * left on disk, so a file a stopped try made reads Added, not Edited by the retry, and the work of a
 * try that was stopped stays in the list. A file a later try put back as it was drops out. Each
 * Attempt's own records hold its changes against its own start, so a try alone reads as before.
 * `activities` are the Task's tries, first to last.
 */
export const taskChanges = (activities: ReadonlyArray<AttemptActivity>): ReadonlyArray<TaskChange> => {
  const byFile = new Map<string, TaskChange>();
  for (const activity of activities) {
    // Each try's changes are against its own start: what each file was then is taken out first, a
    // move's before any other change, as a file made where one was moved from is new.
    const earlier = new Map<FileChange, TaskChange>();
    const moves = activity.changes.filter((change) => change.movedFrom !== null);
    for (const change of [...moves, ...activity.changes.filter((change) => change.movedFrom === null)]) {
      const at = keyOf(change.folder, change.movedFrom ?? change.path);
      const found = byFile.get(at);
      byFile.delete(at);
      if (found !== undefined) earlier.set(change, found);
    }
    for (const change of activity.changes) {
      const before = earlier.get(change);
      const next =
        before === undefined
          ? { ...keptIn(change, activity), activity, attempts: [activity.attempt] }
          : combine(before, change, activity);
      if (next !== null) byFile.set(keyOf(change.folder, change.path), next);
    }
  }
  // In the order each Attempt's own records list them: by folder, then by path.
  return [...byFile.values()].sort((a, b) => order(a.change, b.change));
};
