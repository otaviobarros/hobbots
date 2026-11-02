import { ActivityDetailNotFound, AttemptNotFound } from "@hobbots/api";
import type { AttemptActivity, AttemptId, CommandId, ContentId } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { ActivityRepository, ActivityStore } from "./activity.ts";

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

/** A command's whole redacted output, when its record still names a log. */
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
    return decoder.decode(yield* keptBytes(store, attemptId, contentId));
  });
