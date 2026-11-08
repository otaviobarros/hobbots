import {
  type Attempt,
  type AttemptActivity,
  type AttemptId,
  type FileChange,
  FileChangeId,
  type FileChangeKind,
  type FileVersion,
} from "@hobbots/domain";

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

/** A file as a Task's tries left it, from what it was before the first try to what the latest left (#1218). */
export interface TaskChange extends KeptChange {
  /** The records of the latest try that changed it: whether it settled. */
  readonly activity: AttemptActivity;
  /** The tries that changed it, first to last. */
  readonly attempts: ReadonlyArray<Attempt>;
  /** The hob of each other Attempt that worked in its folder while any of those tries changed it. */
  readonly sharedWithHobs: AttemptActivity["sharedWithHobs"];
}

/** One try's record of a change at a path. */
interface Record {
  readonly change: FileChange;
  readonly activity: AttemptActivity;
}

/**
 * A file there now: the path it was at before the first try, or null for a file a try made on a
 * path an earlier try emptied by moving its file away; and every record of it from there.
 */
interface Live {
  readonly origin: string | null;
  readonly trail: ReadonlyArray<Record>;
}

/** What a path held before the first try that touched it, and the records that keep that version. */
interface Kept {
  readonly version: FileVersion | null;
  readonly in: AttemptActivity;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a: FileChange, b: FileChange) => compare(a.folder, b.folder) || compare(a.path, b.path);

const keyOf = (folder: string, path: string) => `${folder}\0${path}`;
const pathOf = (key: string) => key.slice(key.indexOf("\0") + 1);

/** The same contents of the same kind: a link to `a.txt` is not a file that holds `a.txt`. */
const same = (a: FileVersion | null, b: FileVersion | null) =>
  a === null || b === null ? a === b : a.hash === b.hash && a.kind === b.kind;

const kindOf = (before: FileVersion | null, after: FileVersion | null, moved: boolean): FileChangeKind => {
  if (before?.kind === "link" || after?.kind === "link") return "link";
  if (before === null) return "added";
  if (after === null) return "deleted";
  return moved ? "moved" : "edited";
};

/** Each item once, the first with its key. */
const unique = <A, K>(items: ReadonlyArray<A>, key: (item: A) => K): ReadonlyArray<A> =>
  [...new Map(items.map((item) => [key(item), item] as const).reverse()).values()].reverse();

/** The net change a trail of records makes at `path`, from `before` (kept in `beforeIn`) to what the last left. */
const netChange = (
  trail: ReadonlyArray<Record>,
  path: string,
  movedFrom: string | null,
  before: Kept | undefined,
  /** The other records that changed what the path held, such as an earlier try's deletion of it. */
  also: ReadonlyArray<Record> = [],
): TaskChange => {
  const last = trail.at(-1) as Record;
  const all = [...also, ...trail];
  const was = before?.version ?? null;
  const after = path === last.change.path ? last.change.after : null;
  const sharedWith: ReadonlyArray<AttemptId> = unique(
    all.flatMap((each) => each.change.sharedWith),
    (id) => id,
  );
  const own =
    trail.length === 1 &&
    path === last.change.path &&
    movedFrom === last.change.movedFrom &&
    was === last.change.before;
  const change: FileChange = own
    ? last.change
    : {
        ...last.change,
        // A file left where a later try's record names another path is its own row.
        id: path === last.change.path ? last.change.id : FileChangeId.make(`${last.change.id}:${path}`),
        path,
        kind: kindOf(was, after, movedFrom !== null),
        movedFrom,
        before: was,
        after,
        sharedWith: [...sharedWith],
      };
  return {
    change,
    beforeIn: before?.in ?? last.activity,
    afterIn: last.activity,
    activity: last.activity,
    attempts: [
      ...unique(
        all.map((each) => each.activity.attempt),
        (attempt) => attempt.id,
      ),
    ].sort((a, b) => a.number - b.number),
    sharedWithHobs: unique(
      all.flatMap((each) => each.activity.sharedWithHobs),
      (each) => each.attemptId,
    ),
  };
};

/** Each Task's tries replayed path by path: what each path held first, the files there now, and every record. */
const replay = (activities: ReadonlyArray<AttemptActivity>) => {
  const first = new Map<string, Kept>();
  const live = new Map<string, Live>();
  // The records of a file a try deleted, so one made there again reads as the same path's change.
  const gone = new Map<string, ReadonlyArray<Record>>();
  const touched = new Map<string, ReadonlyArray<Record>>();
  const touch = (key: string, version: FileVersion | null, record: Record) => {
    if (!first.has(key)) first.set(key, { version, in: record.activity });
    touched.set(key, [...(touched.get(key) ?? []), record]);
  };
  for (const activity of activities) {
    // A move pairs a file that left one path with one that appeared at another, both in the same
    // record, so every file a try's moves take is taken out before any is put down: a file made
    // where one was moved from is new, and two files may swap places.
    const moves = activity.changes.filter((change) => change.movedFrom !== null);
    const taken = moves.map((change) => {
      const from = keyOf(change.folder, change.movedFrom as string);
      touch(from, change.before, { change, activity });
      const found = live.get(from);
      live.delete(from);
      return { change, from, found };
    });
    for (const { change, from, found } of taken) {
      const at = keyOf(change.folder, change.path);
      touch(at, null, { change, activity });
      const origin = found === undefined ? from : found.origin;
      live.set(at, { origin, trail: [...(found?.trail ?? []), { change, activity }] });
    }
    for (const change of activity.changes.filter((each) => each.movedFrom === null)) {
      const at = keyOf(change.folder, change.path);
      const record = { change, activity };
      // A file keeps the path it began at only while it is there without a break: one made on a path
      // a try emptied, by a move or a deletion, is new, whatever it holds.
      const untouched = !first.has(at);
      touch(at, change.before, record);
      const there = live.get(at) ?? { origin: untouched ? at : null, trail: gone.get(at) ?? [] };
      gone.delete(at);
      if (change.after === null) {
        live.delete(at);
        gone.set(at, [...there.trail, record]);
      } else {
        live.set(at, { origin: there.origin, trail: [...there.trail, record] });
      }
    }
  }
  return { first, live, touched };
};

/**
 * What a Task's tries changed, as one list (#1218): each path once, from what it held before the
 * first try that touched it to what the latest try left. A retry works on what the tries before it
 * left on disk, so a file a stopped try made reads Added, not Edited by the retry, and the work of a
 * try that was stopped stays in the list. A file a later try put back as it was drops out, and a file
 * a later try deleted or moved away reads Deleted. A file moved onto a path that held nothing before
 * the first try reads Moved from where it was then, while that path is empty; otherwise each path
 * reads against what it held first, as a commit of the folder would. Each Attempt's records hold its changes against
 * the start of the turn that made them. `activities` are the Task's tries, first to last.
 */
export const taskChanges = (activities: ReadonlyArray<AttemptActivity>): ReadonlyArray<TaskChange> => {
  const { first, live, touched } = replay(activities);
  const held = (key: string) => first.get(key)?.version ?? null;
  // A file reads Moved only when the path it left is empty now and the one it is at held nothing:
  // otherwise each path reads against what it held first, as a commit of the folder would.
  const moved = (at: string, file: Live): file is Live & { readonly origin: string } =>
    file.origin !== null &&
    file.origin !== at &&
    held(at) === null &&
    held(file.origin) !== null &&
    !live.has(file.origin);
  // Where a file was before it moved: what was there then is in the file now, not lost.
  const carried = new Set([...live].flatMap(([at, file]) => (moved(at, file) ? [file.origin] : [])));
  const result: Array<TaskChange> = [];
  for (const [at, file] of live) {
    if (moved(at, file)) {
      result.push(netChange(file.trail, pathOf(at), pathOf(file.origin), first.get(file.origin)));
      continue;
    }
    // Any other file reads against what its path held first, whichever file that was.
    const net = netChange(file.trail, pathOf(at), null, first.get(at), touched.get(at));
    if (!same(net.change.before, net.change.after)) result.push(net);
  }
  for (const [at, kept] of first) {
    if (kept.version === null || live.has(at) || carried.has(at)) continue;
    result.push(netChange(touched.get(at) ?? [], pathOf(at), null, kept));
  }
  // In the order each Attempt's own records list them: by folder, then by path.
  return result.sort((a, b) => order(a.change, b.change));
};
