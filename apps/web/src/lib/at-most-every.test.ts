import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atMostEvery } from "./at-most-every.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("atMostEvery", () => {
  it("runs at once when idle, then once for each burst, and always after the last call", () => {
    const run = vi.fn();
    const limited = atMostEvery(run, 1000);
    limited.call();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    // A burst of 50 changes in the next second reads once more, at the end of the second.
    for (let index = 0; index < 50; index++) {
      vi.advanceTimersByTime(10);
      limited.call();
    }
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(2);
    // Quiet again: the next call runs on the next tick.
    vi.advanceTimersByTime(5000);
    limited.call();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("drops a waiting run when cancelled", () => {
    const run = vi.fn();
    const limited = atMostEvery(run, 1000);
    limited.call();
    limited.cancel();
    vi.advanceTimersByTime(2000);
    expect(run).not.toHaveBeenCalled();
  });
});
