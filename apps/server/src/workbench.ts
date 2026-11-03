import {
  ActivityRecorder,
  ActivityRepository,
  ActivityStore,
  type EventPublisher,
  type HobbotsRepository,
  readActivityContent,
  readAttemptActivity,
  readCommandLog,
  TaskFiles,
  type TaskRepository,
} from "@hobbots/agents";
import { ActivityDetailNotFound, AttemptNotFound, HobbotsApi } from "@hobbots/api";
import type { AttemptId } from "@hobbots/domain";
import { recordOverlaps } from "@hobbots/orchestration";
import { EventJournal } from "@hobbots/persistence";
import { DateTime, Effect, Layer, Option, Schedule, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { BackupHolds } from "./backup-holds.ts";
import { EventBus } from "./event-bus.ts";
import { formatCursor } from "./event-stream.ts";

// What an Attempt ran, changed and made (ADR 023). The cursor is taken before the read, so resuming
// the event stream from it replays every record the read could have missed (ADR 013).
export const WorkbenchHandlers = HttpApiBuilder.group(HobbotsApi, "workbench", (handlers) =>
  Effect.gen(function* () {
    // A hub that keeps no Workbench records, as in tests that do not need them, finds none.
    const repo = yield* Effect.serviceOption(ActivityRepository);
    const store = yield* Effect.serviceOption(ActivityStore);
    const journal = yield* EventJournal;
    const files = yield* Effect.serviceOption(TaskFiles);
    const missing = (attemptId: AttemptId) => Effect.fail(new AttemptNotFound({ attemptId }));
    const noDetail = (attemptId: AttemptId) => Effect.fail(new ActivityDetailNotFound({ attemptId }));
    return handlers.handleAll({
      activity: ({ params }) =>
        Effect.gen(function* () {
          const head = yield* journal.head;
          const activity = Option.isNone(repo)
            ? yield* missing(params.attemptId)
            : yield* readAttemptActivity(repo.value, params.attemptId);
          return { cursor: formatCursor(head.epoch, head.sequence), activity };
        }),
      commandLog: ({ params }) =>
        Option.isNone(repo) || Option.isNone(store)
          ? noDetail(params.attemptId)
          : readCommandLog(repo.value, store.value, params.attemptId, params.commandId),
      content: ({ params }) =>
        Option.isNone(repo) || Option.isNone(store)
          ? noDetail(params.attemptId)
          : readActivityContent(repo.value, store.value, params.attemptId, params.contentId),
      files: ({ params }) => (Option.isNone(files) ? missing(params.attemptId) : files.value.list(params.attemptId)),
    });
  }),
);

/**
 * Clears the Workbench's details past the retention window at startup and then hourly (ADR 023).
 * Nothing is deleted while a backup holds cleanup (ADR 026); the next hour's run catches up.
 */
export const ActivityRetention = Layer.effectDiscard(
  Effect.gen(function* () {
    const recorder = yield* ActivityRecorder;
    const holds = yield* Effect.serviceOption(BackupHolds);
    const held = Option.isSome(holds) ? holds.value.cleanupHeld : Effect.succeed(false);
    const prune = Effect.flatMap(held, (isHeld) => (isHeld ? Effect.void : recorder.prune));
    yield* prune.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);
  }),
);

/**
 * Tells a lead when two of its Quest's Tasks change the same file while both are at work (#570):
 * each change a turn records is compared with the other unfinished Tasks of its tree.
 */
export const OverlappingChanges = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const context = yield* Effect.context<ActivityRepository | EventPublisher | HobbotsRepository | TaskRepository>();
    const subscription = yield* bus.subscribe;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) => {
        if (event._tag !== "Journaled" || event.entry.payload._tag !== "FileChangesRecorded") return Effect.void;
        const { taskId, folder, changes } = event.entry.payload;
        return DateTime.now.pipe(
          Effect.flatMap((now) => recordOverlaps({ taskId, folder, changes }, DateTime.formatIso(now))),
        );
      }),
      Effect.provide(context),
      Effect.forkScoped,
    );
  }),
);
