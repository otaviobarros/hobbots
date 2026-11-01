import { Duration, Effect, Schedule } from "effect";

export interface ReadUntilOptions {
  /** The wait before the first retry; each one after waits twice as long. */
  readonly firstRetryMs?: number;
  readonly retries?: number;
}

/**
 * Reads until the answer settles: the read answered, not null, and `settled` holds for it. Tries
 * again on a doubling wait, a bounded number of times, so a hub that stays out of reach is left to
 * the event stream's next connection. Answers the last answer read, or null when none came.
 */
export const readUntil = <A>(
  read: () => Promise<A | null>,
  settled: (answer: A) => boolean = () => true,
  { firstRetryMs = 250, retries = 5 }: ReadUntilOptions = {},
): Promise<A | null> => {
  let last: A | null = null;
  return Effect.runPromise(
    Effect.promise(read).pipe(
      Effect.flatMap((answer) => {
        if (answer !== null) last = answer;
        return answer !== null && settled(answer) ? Effect.void : Effect.fail("unsettled" as const);
      }),
      Effect.retry({ schedule: Schedule.exponential(Duration.millis(firstRetryMs)), times: retries }),
      Effect.ignore,
      Effect.map(() => last),
    ),
  );
};
