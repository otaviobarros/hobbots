import { type Clock, Duration, Effect } from "effect";

/**
 * The wall clock, moved forward on demand, so a case can let a day pass without waiting a day.
 * Sleeps end at their real time or as soon as the clock is moved past them, whichever comes first.
 */
export const movableClock = () => {
  let offset = 0;
  const sleepers = new Set<{ readonly until: number; readonly wake: () => void }>();
  const now = () => Date.now() + offset;
  const nanos = () => BigInt(now()) * 1_000_000n;
  const monotonic = () => process.hrtime.bigint() + BigInt(offset) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: monotonic,
    monotonicTimeNanos: Effect.sync(monotonic),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const millis = Duration.toMillis(duration);
        const done = () => {
          clearTimeout(timer);
          sleepers.delete(sleeper);
        };
        const sleeper = {
          until: now() + millis,
          wake: () => {
            done();
            resume(Effect.void);
          },
        };
        // Node's timers hold at most about 24.8 days; nothing here sleeps that long.
        const timer = setTimeout(sleeper.wake, Math.min(millis, 2 ** 31 - 1));
        timer.unref();
        sleepers.add(sleeper);
        return Effect.sync(done);
      }),
  };
  const advance = (duration: Duration.Input) => {
    offset += Duration.toMillis(duration);
    for (const sleeper of [...sleepers]) if (sleeper.until <= now()) sleeper.wake();
  };
  return { clock, advance };
};
