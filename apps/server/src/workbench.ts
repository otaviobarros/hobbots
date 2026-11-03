import {
  ActivityRecorder,
  ActivityRepository,
  ActivityStore,
  readActivityContent,
  readAttemptActivity,
  readCommandLog,
  TaskFiles,
} from "@hobbots/agents";
import { ActivityDetailNotFound, AttemptNotFound, HobbotsApi } from "@hobbots/api";
import type { AttemptId } from "@hobbots/domain";
import { EventJournal } from "@hobbots/persistence";
import { Effect, Layer, Option, Schedule } from "effect";
import { HttpApiBuilder } from "effect/http-api";
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

/** Clears the Workbench's details past the retention window at startup and then hourly (ADR 023). */
export const ActivityRetention = Layer.effectDiscard(
  Effect.gen(function* () {
    const recorder = yield* ActivityRecorder;
    yield* recorder.prune.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);
  }),
);
