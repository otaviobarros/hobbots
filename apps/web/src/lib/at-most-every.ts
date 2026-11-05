/**
 * Runs `run` at most once every `everyMs`: a call while idle runs it on the next tick, and the calls
 * that land before the interval has passed run it once more at its end, so the last call is always
 * followed by a run. `cancel` drops a run that is waiting.
 */
export const atMostEvery = (
  run: () => void,
  everyMs: number,
): { readonly call: () => void; readonly cancel: () => void } => {
  let waiting: ReturnType<typeof setTimeout> | undefined;
  let lastRun = Number.NEGATIVE_INFINITY;
  return {
    call: () => {
      if (waiting !== undefined) return;
      waiting = setTimeout(
        () => {
          waiting = undefined;
          lastRun = Date.now();
          run();
        },
        Math.max(0, lastRun + everyMs - Date.now()),
      );
    },
    cancel: () => {
      clearTimeout(waiting);
      waiting = undefined;
    },
  };
};
