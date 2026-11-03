import { ActivityRepository, EventPublisher, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  type AgentId,
  ancestorsOf,
  CheckpointId,
  type FileChange,
  isTerminalTask,
  type Task,
  type TaskId,
  type TaskTree,
} from "@hobbots/domain";
import { Effect, Option, Schedule } from "effect";

/**
 * Two Tasks of the same work changing one file (#570, ADR 018). Every member gets folders of its
 * own lead's, so nothing keeps two members from writing the same file while both are at work. When
 * a turn records a change to a file that another unfinished Task in its tree, owned by another hob,
 * also changed in its current Attempt, the hub records one finding on the Task that changed it
 * last, about the other Task too. The finding reaches the nearest lead as any finding does, and both
 * Tasks show it. A change that leaves a file's bytes as they were is not a change, so it is not seen.
 */

/** The changes one turn recorded in one of its folders, as `FileChangesRecorded` carries them. */
export interface RecordedChanges {
  readonly taskId: TaskId;
  readonly folder: string;
  readonly changes: ReadonlyArray<FileChange>;
}

/** Two Tasks that changed the same file: the one that changed it last, and the other. */
export interface Overlap {
  readonly writer: Task;
  readonly other: Task;
  /** The file, as the writer's folder names it: the folder, then its path inside it. */
  readonly folder: string;
  readonly path: string;
}

/** A file's full path, with `/` between names whatever the folder used, so two folders' paths compare. */
const fullPath = (folder: string, path: string) => `${folder.replaceAll("\\", "/").replace(/\/+$/, "")}/${path}`;

/** The full paths a change touches: where the file is, and for a move where it was. */
const touched = (change: Pick<FileChange, "folder" | "path" | "movedFrom">) =>
  change.movedFrom === null
    ? [fullPath(change.folder, change.path)]
    : [fullPath(change.folder, change.path), fullPath(change.folder, change.movedFrom)];

/**
 * The Tasks in the tree a writer may have stepped on: owned by another hob, with an Attempt. One
 * that ended still counts for changes made before it ended, such as those its last scan records
 * once its turn completed it (`overlapsOf`).
 */
export const othersAtWork = (tree: TaskTree, writer: Task): ReadonlyArray<Task> =>
  tree.tasks.filter(
    (task) => task.id !== writer.id && task.ownerId !== writer.ownerId && task.currentAttemptId !== null,
  );

/**
 * Whether two changes to one file were made while both Tasks were at work: the Task that changed
 * it first had not ended when the other changed it. A Task's last change is often recorded just
 * after its own turn completed it, so the Task that changed it last may have ended since.
 */
const bothAtWork = (first: Task, later: string) => !isTerminalTask(first.state) || first.updatedAt >= later;

/**
 * The changes `lead` made before it delegated `task`, or a Task above it, are its own work handed
 * down, not a clash, even while its Attempt stays open for its whole Quest (#658): left out.
 */
const handedDown = (lead: Task, changes: ReadonlyArray<FileChange>, task: Task, tasks: ReadonlyArray<Task>) =>
  ancestorsOf(task, tasks).some((above) => above.id === lead.id)
    ? changes.filter((change) => change.recordedAt >= task.createdAt)
    : changes;

/**
 * The overlaps `recorded` makes with what other Tasks changed in their current Attempts: one per
 * other Task and file, in the order the recorded changes list them. The writer is the Task whose
 * change was recorded last, so a change heard late is still pinned on the hob that made it. A pair
 * that both ended has no one left to tell, so it is none. `tasks` is the tree, to tell who leads whom.
 */
export const overlapsOf = (
  task: Task,
  recorded: RecordedChanges,
  others: ReadonlyArray<{ readonly task: Task; readonly changes: ReadonlyArray<FileChange> }>,
  tasks: ReadonlyArray<Task>,
): ReadonlyArray<Overlap> => {
  const found: Array<Overlap> = [];
  for (const other of others) {
    if (isTerminalTask(task.state) && isTerminalTask(other.task.state)) continue;
    const theirChanges = handedDown(other.task, other.changes, task, tasks);
    for (const change of handedDown(task, recorded.changes, other.task, tasks)) {
      const mine = new Set(touched({ ...change, folder: recorded.folder }));
      const theirs = theirChanges.find((each) => touched(each).some((path) => mine.has(path)));
      if (theirs === undefined) continue;
      const [later, overlap] =
        theirs.recordedAt > change.recordedAt
          ? [theirs, { writer: other.task, other: task, folder: theirs.folder, path: theirs.path }]
          : [change, { writer: task, other: other.task, folder: recorded.folder, path: change.path }];
      if (bothAtWork(overlap.other, later.recordedAt)) found.push(overlap);
    }
  }
  return found;
};

/**
 * The finding's id: the same for a pair of Tasks and a file whichever of them wrote last, so each
 * pair and file gets one finding however often their turns record the change.
 */
export const overlapCheckpointId = (overlap: Overlap) => {
  const [first, second] = [overlap.writer.id, overlap.other.id].sort();
  return CheckpointId.make(`overlap:${first}:${second}:${fullPath(overlap.folder, overlap.path)}`);
};

/** What the finding says, for the lead it reaches and on both Tasks. */
const overlapSummary = (overlap: Overlap, names: (id: AgentId) => string) =>
  `${names(overlap.writer.ownerId)} changed ${overlap.path} in ${overlap.folder}, which ` +
  `${names(overlap.other.ownerId)}'s Task ${overlap.other.id} also changed while both were at work. ` +
  "Check which version should stay.";

/** Records a finding for each new overlap that `recorded` makes, and publishes its events. */
const findingsFor = (recorded: RecordedChanges, at: string) =>
  Effect.gen(function* () {
    if (recorded.changes.length === 0) return;
    const tasks = yield* TaskRepository;
    const activity = yield* ActivityRepository;
    const hobs = yield* HobbotsRepository;
    const publisher = yield* EventPublisher;
    // The writer's own read names its top Task, whose tree holds every Task of the work.
    const own = yield* tasks.readTree(recorded.taskId);
    const writer = Option.isNone(own) ? undefined : own.value.tasks.find((task) => task.id === recorded.taskId);
    if (writer === undefined) return;
    const tree = yield* tasks.readTree(writer.rootId);
    if (Option.isNone(tree)) return;
    const others = yield* Effect.forEach(othersAtWork(tree.value, writer), (task) =>
      activity
        .read(task.currentAttemptId as NonNullable<Task["currentAttemptId"]>)
        .pipe(Effect.map((read) => ({ task, changes: Option.isSome(read) ? read.value.changes : [] }))),
    );
    const known = new Set(tree.value.checkpoints.map((checkpoint) => checkpoint.id));
    const fresh = overlapsOf(writer, recorded, others, tree.value.tasks).filter((overlap) => {
      const id = overlapCheckpointId(overlap);
      if (known.has(id)) return false;
      known.add(id);
      return true;
    });
    if (fresh.length === 0) return;
    const names = new Map<AgentId, string>();
    for (const id of new Set(fresh.flatMap((overlap) => [overlap.writer.ownerId, overlap.other.ownerId]))) {
      const hob = yield* hobs.findAgent(id);
      names.set(id, Option.isSome(hob) ? hob.value.name : `hob ${id}`);
    }
    for (const overlap of fresh) {
      // The finding sits on the Task that changed the file last, or on the other while that one ended.
      const [holder, about] = isTerminalTask(overlap.writer.state)
        ? [overlap.other, overlap.writer]
        : [overlap.writer, overlap.other];
      const committed = yield* tasks.recordCheckpoint({
        id: overlapCheckpointId(overlap),
        taskId: holder.id,
        source: "automatic",
        kind: "finding",
        milestoneId: null,
        summary: overlapSummary(overlap, (id) => names.get(id) ?? `hob ${id}`),
        aboutTaskId: about.id,
        createdAt: at,
      });
      yield* publisher.publish(committed.entries);
    }
  });

/**
 * Records the findings `recorded` makes, trying again a few times. One that still fails is logged
 * and changes nothing: the changes themselves are recorded, and `reconcileOverlaps` looks again
 * when the hub next starts.
 */
export const recordOverlaps = (recorded: RecordedChanges, at: string) =>
  findingsFor(recorded, at).pipe(
    Effect.retry({ schedule: Schedule.exponential("50 millis"), times: 3 }),
    Effect.catchCause((cause) => Effect.logWarning("Could not record overlapping changes", cause)),
  );

/**
 * Looks over every Task's recorded changes in work still going on, as the hub starts: a finding
 * whose changes were recorded just before the hub stopped, or whose recording failed, is recorded
 * now. Each pair and file has one id, so a finding already recorded is never recorded twice.
 */
export const reconcileOverlaps = (at: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const activity = yield* ActivityRepository;
    for (const rootId of yield* tasks.listRootsAtWork) {
      const tree = yield* tasks.readTree(rootId);
      if (Option.isNone(tree)) continue;
      for (const task of tree.value.tasks) {
        if (task.currentAttemptId === null) continue;
        const read = yield* activity.read(task.currentAttemptId);
        const changes = Option.isSome(read) ? read.value.changes : [];
        for (const folder of new Set(changes.map((change) => change.folder))) {
          yield* recordOverlaps(
            { taskId: task.id, folder, changes: changes.filter((change) => change.folder === folder) },
            at,
          );
        }
      }
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not look over overlapping changes", cause)));
