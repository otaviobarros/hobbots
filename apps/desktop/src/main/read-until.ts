import { Duration, Effect, Schedule } from "effect";

export interface ReadUntilOptions {
  /** The wait before the first retry; each one after waits twice as long, up to `maxRetryMs`. */
  readonly firstRetryMs?: number;
  readonly maxRetryMs?: number;
}

/**
 * Reads until the hub answers: a read that answered null is made again on a doubling wait, capped,
 * for as long as it takes, since no later event may come to ask again.
 */
export const readUntil = <A>(
  read: () => Promise<A | null>,
  { firstRetryMs = 250, maxRetryMs = 30_000 }: ReadUntilOptions = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.promise(read).pipe(
      Effect.flatMap((answer) => (answer !== null ? Effect.succeed(answer) : Effect.fail("unanswered" as const))),
      Effect.retry(
        Schedule.min([
          Schedule.exponential(Duration.millis(firstRetryMs)),
          Schedule.spaced(Duration.millis(maxRetryMs)),
        ]),
      ),
    ),
  );
