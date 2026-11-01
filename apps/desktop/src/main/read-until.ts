import { Duration, Effect, Schedule } from "effect";

export interface ReadUntilOptions {
  /** The wait before the first retry; each one after waits twice as long, up to `maxRetryMs`. */
  readonly firstRetryMs?: number;
  readonly maxRetryMs?: number;
}

/**
 * Reads until the answer settles: the read answered, not null, and `settled` holds for it. Tries
 * again on a doubling wait, capped, for as long as it takes, since no later event may come to ask
 * again. `settled` is asked at each answer, so it can follow what changed meanwhile.
 */
export const readUntil = <A>(
  read: () => Promise<A | null>,
  settled: (answer: A) => boolean = () => true,
  { firstRetryMs = 250, maxRetryMs = 30_000 }: ReadUntilOptions = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.promise(read).pipe(
      Effect.flatMap((answer) =>
        answer !== null && settled(answer) ? Effect.succeed(answer) : Effect.fail("unsettled" as const),
      ),
      Effect.retry(
        Schedule.min([
          Schedule.exponential(Duration.millis(firstRetryMs)),
          Schedule.spaced(Duration.millis(maxRetryMs)),
        ]),
      ),
    ),
  );
