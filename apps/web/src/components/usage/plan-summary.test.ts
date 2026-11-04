import type { PlanUsage } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { limitRefill, planSummary } from "./plan-summary.ts";

const now = new Date("2026-11-04T14:00:00.000Z");
const inTwoHours = "2026-11-04T16:00:00.000Z";

const plan = (percent: number): PlanUsage => ({
  runtime: "claude-code",
  reported: true,
  meters: [
    { kind: "session", group: "session", percent, resetsAt: inTwoHours, scope: null, severity: "normal", active: true },
  ],
  extraUsage: null,
  checkedAt: null,
});

describe("plan summary", () => {
  it("says what is left of the window that sets the level, and when it refills", () => {
    const summary = planSummary(plan(38), now);
    expect(summary?.level).toBe("ok");
    expect(summary?.left).toBeCloseTo(0.62);
    expect(summary?.line).toMatch(/^62% left · This session · refills \d/);
    expect(planSummary(undefined, now)).toBeNull();
    expect(planSummary({ ...plan(38), reported: false }, now)).toBeNull();
  });

  it("gives a stopped reply the plan's refill when the plan is used up, else the reply's own", () => {
    const stoppedUntil = "2026-11-04T15:00:00.000Z";
    expect(limitRefill(plan(100), stoppedUntil, now)).toMatch(/^Refills in 2 hours, at /);
    expect(limitRefill(plan(38), stoppedUntil, now)).toMatch(/^Refills in 1 hour, at /);
    expect(limitRefill(undefined, null, now)).toBe("The provider didn't say when this refills.");
  });
});
