import { Duration, Effect, Schedule, Schema } from "effect";

/**
 * How much longer a wait may take than its limit says: `HOBBOTS_TEST_WAIT_SCALE` when set, else 2
 * on CI, where runners are shared and slower, else 1.
 */
const waitScale = () => {
  const set = Number(process.env.HOBBOTS_TEST_WAIT_SCALE);
  if (Number.isFinite(set) && set > 0) return set;
  return process.env.CI ? 2 : 1;
};

const shown = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

/** A test waited for some state and its time ran out first. `last` is the last value it read. */
export class StillWaiting extends Schema.TaggedError<StillWaiting>()("StillWaiting", {
  what: Schema.String,
  waited: Schema.String,
  last: Schema.Unknown,
}) {
  override get message() {
    return `Still waiting for ${this.what} after ${this.waited}. Last read: ${shown(this.last)}`;
  }
}

export interface WaitOptions {
  /** What the test waits for, as the failure names it. */
  readonly what?: string;
  /** The longest the wait may take, before the scale for CI. 10 seconds when left out. */
  readonly within?: Duration.Input;
  /** How long to wait between reads. 10 milliseconds when left out. */
  readonly every?: Duration.Input;
}

const notYet = Symbol("not yet");

/**
 * Reads `read` until `ready` holds for what it read, and returns that. Waits for state, not for a
 * fixed time or number of tries: it gives up after a time limit, scaled for CI, and then fails with
 * `StillWaiting`, which holds the last value read, so a failure says which state it was stuck in.
 * A failure of `read` itself ends the wait at once.
 */
export function waitUntil<A, B extends A, E, R>(
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => value is B,
  options?: WaitOptions,
): Effect.Effect<B, E | StillWaiting, R>;
export function waitUntil<A, E, R>(
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
  options?: WaitOptions,
): Effect.Effect<A, E | StillWaiting, R>;
export function waitUntil<A, E, R>(
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
  options: WaitOptions = {},
): Effect.Effect<A, E | StillWaiting, R> {
  return Effect.suspend(() => {
    const within = Duration.times(Duration.fromInputUnsafe(options.within ?? "10 seconds"), waitScale());
    let last: unknown;
    return read.pipe(
      Effect.flatMap((value) => {
        last = value;
        return ready(value) ? Effect.succeed(value) : Effect.fail(notYet);
      }),
      Effect.retry({
        while: (error) => error === notYet,
        schedule: Schedule.spaced(options.every ?? "10 millis").pipe(Schedule.upTo({ duration: within })),
      }),
      Effect.catchIf(
        (error): error is typeof notYet => error === notYet,
        () =>
          Effect.fail(new StillWaiting({ what: options.what ?? "the state", waited: Duration.format(within), last })),
      ),
    );
  });
}

/** Waits until `holds` is true, read again on each try. See `waitUntil`. */
export const waitFor = (what: string, holds: () => boolean, options: Omit<WaitOptions, "what"> = {}) =>
  Effect.asVoid(waitUntil(Effect.sync(holds), (held) => held, { ...options, what }));

/** Waits until `find` finds something, and returns it. See `waitUntil`. */
export const waitToFind = <A>(what: string, find: () => A | undefined, options: Omit<WaitOptions, "what"> = {}) =>
  waitUntil(Effect.sync(find), (found): found is A => found !== undefined, { ...options, what });
