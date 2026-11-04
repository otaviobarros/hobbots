import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW_AFTER_MS, STUCK_AFTER_MS, startWaitClock, type WaitStage } from "./wait-stage.ts";

describe("startWaitClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const record = () => {
    const stages: WaitStage[] = [];
    return { stages, onStage: (stage: WaitStage) => stages.push(stage) };
  };

  it("stays quiet for the first second, so a fast read flashes no text", () => {
    const { stages, onStage } = record();
    startWaitClock(onStage);
    vi.advanceTimersByTime(SLOW_AFTER_MS - 1);
    expect(stages).toEqual([]);
  });

  it("turns slow at 1 second and stuck at 10 seconds", () => {
    const { stages, onStage } = record();
    startWaitClock(onStage);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    expect(stages).toEqual(["slow"]);
    vi.advanceTimersByTime(STUCK_AFTER_MS - SLOW_AFTER_MS - 1);
    expect(stages).toEqual(["slow"]);
    vi.advanceTimersByTime(1);
    expect(stages).toEqual(["slow", "stuck"]);
  });

  it("reports each stage once, however long the wait runs", () => {
    const { stages, onStage } = record();
    startWaitClock(onStage);
    vi.advanceTimersByTime(STUCK_AFTER_MS * 6);
    expect(stages).toEqual(["slow", "stuck"]);
  });

  it("starts again from slow after Try again and waits another 10 seconds", () => {
    const { stages, onStage } = record();
    startWaitClock(onStage, "slow");
    vi.advanceTimersByTime(STUCK_AFTER_MS - 1);
    expect(stages).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stages).toEqual(["stuck"]);
  });

  it("reports nothing once stopped, as when the value lands", () => {
    const { stages, onStage } = record();
    const stop = startWaitClock(onStage);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    stop();
    vi.advanceTimersByTime(STUCK_AFTER_MS);
    expect(stages).toEqual(["slow"]);
  });
});
