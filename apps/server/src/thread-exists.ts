import type { HobbotsRepository } from "@hobbots/agents";
import { ThreadNotFound } from "@hobbots/api";
import type { ThreadId } from "@hobbots/domain";
import { Effect, Option } from "effect";

/** Runs `then` for a thread the hub has, and answers ThreadNotFound for one it does not. */
export const forExistingThread = <A, E, R>(
  repo: HobbotsRepository["Service"],
  threadId: ThreadId,
  then: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ThreadNotFound, R> =>
  repo
    .findThread(threadId)
    .pipe(
      Effect.flatMap(
        (thread): Effect.Effect<A, E | ThreadNotFound, R> =>
          Option.isNone(thread) ? Effect.fail(new ThreadNotFound({ threadId })) : then,
      ),
    );
