import { ActivityDetailNotFound, AttemptNotFound, TaskNotFound } from "@hobbots/api";
import {
  type AttemptActivity,
  type AttemptId,
  type CommandId,
  type ContentId,
  stripEscapes,
  type TaskFile,
  type TaskId,
  TreeActivity,
  TreeAttempt,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { ActivityRepository, ActivityStore } from "./activity.ts";
import type { TaskRepository } from "./tasks.ts";

/** The Workbench's reads of an Attempt's records and their details (ADR 023). */

export const readAttemptActivity = (
  repo: ActivityRepository["Service"],
  attemptId: AttemptId,
): Effect.Effect<AttemptActivity, AttemptNotFound> =>
  Effect.flatMap(repo.read(attemptId), (activity) =>
    Option.match(activity, {
      onNone: () => Effect.fail(new AttemptNotFound({ attemptId })),
      onSome: Effect.succeed,
    }),
  );

/** How many Attempts' files are looked at in the hob's folders at once, on top of each listing's own. */
const FILES_CONCURRENCY = 4;

/**
 * What every Attempt under a Task ran, changed and made, in one read for the Quest's Workbench
 * (#899): the Task's tree as `GET /api/tasks/:taskId` reads it, then the records of all its Attempts
 * at once, each with the files it made or touched as `filesOf` finds them now. The records follow
 * the per-Attempt reads' rules: redacted when recorded, cut to their start and end, and their details
 * said cleared past the retention window.
 */
export const readTreeActivity = (
  tasks: TaskRepository["Service"],
  repo: ActivityRepository["Service"],
  filesOf: (activity: AttemptActivity) => Effect.Effect<ReadonlyArray<TaskFile>>,
  taskId: TaskId,
): Effect.Effect<TreeActivity, TaskNotFound> =>
  Effect.gen(function* () {
    const tree = yield* tasks.readTree(taskId);
    if (Option.isNone(tree)) return yield* new TaskNotFound({ taskId });
    const owners = new Map(tree.value.tasks.map((task) => [task.id, task.ownerId] as const));
    const activities = yield* repo.readMany(tree.value.attempts.map((attempt) => attempt.id));
    const attempts = yield* Effect.forEach(
      activities,
      (activity) =>
        Effect.map(
          filesOf(activity),
          (files) =>
            new TreeAttempt({
              ownerId: owners.get(activity.attempt.taskId) ?? activity.attempt.agentId,
              activity,
              files,
            }),
        ),
      { concurrency: FILES_CONCURRENCY },
    );
    return new TreeActivity({ taskId, attempts });
  });

const keptBytes = (store: ActivityStore["Service"], attemptId: AttemptId, contentId: ContentId) =>
  Effect.flatMap(store.get(contentId), (bytes) =>
    Option.match(bytes, {
      onNone: () => Effect.fail(new ActivityDetailNotFound({ attemptId })),
      onSome: Effect.succeed,
    }),
  );

/**
 * Kept contents, only when a record of the Attempt names them and they were not cleared: a request
 * never reaches contents another Attempt kept, or a file the hub did not keep.
 */
export const readActivityContent = (
  repo: ActivityRepository["Service"],
  store: ActivityStore["Service"],
  attemptId: AttemptId,
  contentId: ContentId,
): Effect.Effect<Uint8Array, ActivityDetailNotFound> =>
  Effect.gen(function* () {
    if (!(yield* repo.names(attemptId, contentId))) return yield* new ActivityDetailNotFound({ attemptId });
    return yield* keptBytes(store, attemptId, contentId);
  });

const decoder = new TextDecoder();

/**
 * A command's whole redacted output, when its record still names a log, as plain text: it opens in
 * a browser tab, which would show a colored command's escape sequences as they are (#902).
 */
export const readCommandLog = (
  repo: ActivityRepository["Service"],
  store: ActivityStore["Service"],
  attemptId: AttemptId,
  commandId: CommandId,
): Effect.Effect<string, ActivityDetailNotFound> =>
  Effect.gen(function* () {
    const command = yield* repo.findCommand(attemptId, commandId);
    const contentId = Option.isSome(command) ? command.value.log?.contentId : null;
    if (contentId == null) return yield* new ActivityDetailNotFound({ attemptId });
    return stripEscapes(decoder.decode(yield* keptBytes(store, attemptId, contentId)));
  });
