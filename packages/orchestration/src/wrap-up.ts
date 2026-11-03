import { ActivityRepository, GitWorkspace, type UncommittedFiles } from "@hobbots/agents";
import { CheckpointId, type Task } from "@hobbots/domain";
import { Effect, Option } from "effect";

/**
 * What a Task leaves behind in its folders when it completes (#586). `complete_task` checks the
 * responsibility ledger, which says nothing of the workspace, so a Task could finish with files it
 * changed in a Git repository still uncommitted, and nobody would hear of it. The completion still
 * goes ahead: the hob is warned in the tool's answer, and the Task keeps an `uncommitted`
 * checkpoint its Summary shows.
 */

/** What the completion records and the hob reads about the files it left uncommitted. */
export interface WrapUp {
  readonly uncommitted?: { readonly id: CheckpointId; readonly summary: string };
  readonly warning: string | null;
}

const NOTHING: WrapUp = { warning: null };

/** The files of each repository, as one line: `docs/SPEC.md and web/badge.png in /work/site`. */
const listOf = (found: ReadonlyArray<UncommittedFiles>) =>
  found
    .map(({ repository, paths }) => {
      const names = paths.length <= 1 ? paths.join("") : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)}`;
      return `${names} in ${repository}`;
    })
    .join("; ");

/** What `found` says on the Task and to its hob, or nothing when it is empty. */
const wrapUpOf = (task: Task, found: ReadonlyArray<UncommittedFiles>): WrapUp => {
  const count = found.reduce((total, each) => total + each.paths.length, 0);
  if (count === 0 || task.currentAttemptId === null) return NOTHING;
  const files = count === 1 ? "1 file" : `${count} files`;
  return {
    uncommitted: {
      id: CheckpointId.make(`uncommitted:${task.currentAttemptId}`),
      summary: `Left ${files} uncommitted since the last commit: ${listOf(found)}.`,
    },
    warning:
      `Warning: ${files} you changed ${count === 1 ? "is" : "are"} not committed: ${listOf(found)}. ` +
      "Commit them now if the work asked for a commit, or say in your reply that they are left uncommitted.",
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
  return (task: Task): Effect.Effect<WrapUp> =>
    Effect.gen(function* () {
      if (Option.isNone(activity) || Option.isNone(workspace) || task.currentAttemptId === null) return NOTHING;
      const read = yield* activity.value.read(task.currentAttemptId);
      if (Option.isNone(read)) return NOTHING;
      const files = read.value.changes.flatMap((change) => [
        { folder: change.folder, path: change.path },
        ...(change.movedFrom === null ? [] : [{ folder: change.folder, path: change.movedFrom }]),
      ]);
      if (files.length === 0) return NOTHING;
      return wrapUpOf(task, yield* workspace.value.uncommitted(files));
    });
});
