import { useEffect, useState } from "react";

/**
 * How long a region has waited for its content (Patterns › Loading in the design system).
 *
 * - `none`: under a second. Only the skeletons show, so a fast read flashes no text.
 * - `slow`: a second or more. One line names what the region is waiting on.
 * - `stuck`: ten seconds or more. An outside call says it is slow and offers Try again.
 */
export type WaitStage = "none" | "slow" | "stuck";

/** When the wait line appears. */
export const SLOW_AFTER_MS = 1000;

/** When an outside call is called slow and offers Try again. */
export const STUCK_AFTER_MS = 10_000;

/**
 * Moves through the wait stages on timers, starting at `from`, and calls `onStage` as each one
 * begins. From `none` it reaches `slow` after 1 second and `stuck` after 10. From `slow`, as after
 * Try again, it reaches `stuck` 10 seconds later. Returns a function that stops the timers.
 */
export function startWaitClock(onStage: (stage: WaitStage) => void, from: "none" | "slow" = "none"): () => void {
  const timers =
    from === "none"
      ? [setTimeout(onStage, SLOW_AFTER_MS, "slow"), setTimeout(onStage, STUCK_AFTER_MS, "stuck")]
      : [setTimeout(onStage, STUCK_AFTER_MS, "stuck")];
  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}

/** The wait stage of one region, and a way to start its clock again. */
export interface Wait {
  readonly stage: WaitStage;
  /** Starts the clock again from `slow`, for Try again: the wait line stays, and the slow sentence waits another 10 seconds. */
  readonly restart: () => void;
}

/**
 * Reports how long `pending` has been true, as a wait stage, so screens share one clock instead of
 * running their own timers. Pass a query's first-load flag, such as TanStack Query's `isPending`:
 * a refresh keeps the last value and shows no wait.
 */
export function useWaitStage(pending: boolean): Wait {
  const [stage, setStage] = useState<WaitStage>("none");
  const [attempt, setAttempt] = useState(0);
  const [wasPending, setWasPending] = useState(pending);

  // A new wait starts from the beginning: adjust state while rendering, as React advises, rather
  // than in an effect (STD-REACT-004).
  if (pending !== wasPending) {
    setWasPending(pending);
    setStage("none");
    setAttempt(0);
  }

  useEffect(() => {
    if (!pending) return;
    return startWaitClock(setStage, attempt > 0 ? "slow" : "none");
  }, [pending, attempt]);

  const restart = () => {
    setStage("slow");
    setAttempt((count) => count + 1);
  };

  return { stage: pending ? stage : "none", restart };
}
