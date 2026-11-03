import {
  ActivityRecorder,
  ActivityRepository,
  GitWorkspace,
  TaskRepository,
  type UncommittedFiles,
} from "@hobbots/agents";
import { CheckpointId, type Task, TaskId } from "@hobbots/domain";
import { Effect, Option } from "effect";

/**
 * What a Task leaves behind in its folders when it completes (#586). `complete_task` checks the
 * responsibility ledger, which says nothing of the workspace, so a Task could finish with files it
 * changed in a Git repository still uncommitted, and nobody would hear of it. The completion still
 * goes ahead: the hob is warned in the tool's answer, and the Task keeps an `uncommitted`
 * checkpoint its Summary shows. The top Task of a Quest is held instead until its lead says why it
 * leaves them (#665).
 */

/** What the completion records and the hob reads about the files it left uncommitted. */
export interface WrapUp {
  readonly uncommitted?: { readonly id: CheckpointId; readonly summary: string };
  readonly warning: string | null;
  /** Why the completion is held instead, naming the files, for a Task that may not leave them silently (#665). */
  readonly held: string | null;
}

/**
 * How the completion treats what is left: `hold` refuses it until `reason` says why the files stay
 * uncommitted, as for the top Task of a Quest (#665); a reason is kept with them.
 */
export interface WrapUpPolicy {
  readonly hold: boolean;
  readonly reason?: string | undefined;
}

const NOTHING: WrapUp = { warning: null, held: null };

/** The files of each repository, as one line: `docs/SPEC.md and web/badge.png in /work/site`. */
const listOf = (found: ReadonlyArray<UncommittedFiles>) =>
  found
    .map(({ repository, paths }) => {
      const names = paths.length <= 1 ? paths.join("") : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)}`;
      return `${names} in ${repository}`;
    })
    .join("; ");

/** What `found` says on the Task and to its hob, or nothing when it is empty. */
const wrapUpOf = (task: Task, found: ReadonlyArray<UncommittedFiles>, policy: WrapUpPolicy): WrapUp => {
  const count = found.reduce((total, each) => total + each.paths.length, 0);
  if (count === 0 || task.currentAttemptId === null) return NOTHING;
  const files = count === 1 ? "1 file" : `${count} files`;
  const list = listOf(found);
  const { reason } = policy;
  return {
    uncommitted: {
      id: CheckpointId.make(`uncommitted:${task.currentAttemptId}`),
      summary: `Left ${files} uncommitted since the last commit: ${list}.${reason === undefined ? "" : ` Left on purpose: ${reason}`}`,
    },
    warning:
      reason !== undefined
        ? null
        : `Warning: ${files} you changed ${count === 1 ? "is" : "are"} not committed: ${list}. ` +
          "Commit them now if the work asked for a commit, or say in your reply that they are left uncommitted.",
    held:
      policy.hold && reason === undefined
        ? `Task ${task.id} changed ${files} it has not committed: ${list}. ` +
          "Commit them if the work asked for a commit, then complete the Task. To leave them, call complete_task again with leave_uncommitted saying why."
        : null,
  };
};

/**
 * Reads what the Task's current Attempt changed, as the Workbench recorded it, and which of those
 * files differ from their repository's last commit. A hub that keeps no Workbench records or reads
 * no Git state finds nothing.
 */
export const makeWrapUp = Effect.gen(function* () {
  const activity = yield* Effect.serviceOption(ActivityRepository);
  const workspace = yield* Effect.serviceOption(GitWorkspace);
  return (task: Task, policy: WrapUpPolicy): Effect.Effect<WrapUp> =>
    Effect.gen(function* () {
      if (Option.isNone(activity) || Option.isNone(workspace) || task.currentAttemptId === null) return NOTHING;
      const read = yield* activity.value.read(task.currentAttemptId);
      if (Option.isNone(read)) return NOTHING;
      const files = read.value.changes.flatMap((change) => [
        { folder: change.folder, path: change.path },
        ...(change.movedFrom === null ? [] : [{ folder: change.folder, path: change.movedFrom }]),
      ]);
      if (files.length === 0) return NOTHING;
      return wrapUpOf(task, yield* workspace.value.uncommitted(files), policy);
    });
});

/**
 * Records now what the live turn on a Task's current Attempt changed so far, before
 * `complete_task` reads it in its transaction: a file tool's change is scanned a moment after the
 * call ends, and the call may come first. It runs outside the call's transaction, since recording
 * writes records of its own. A hub without the Workbench's recorder has nothing to wait for.
 */
export const makeSettle = Effect.gen(function* () {
  const recorder = yield* Effect.serviceOption(ActivityRecorder);
  const tasks = yield* TaskRepository;
  return (input: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      const named = (input as { readonly task_id?: unknown } | null)?.task_id;
      if (Option.isNone(recorder) || typeof named !== "string") return;
      const tree = yield* tasks.readTree(TaskId.make(named));
      const attemptId = Option.isSome(tree) ? tree.value.tasks[0]?.currentAttemptId : null;
      if (attemptId) yield* recorder.value.settle(attemptId);
    });
});
