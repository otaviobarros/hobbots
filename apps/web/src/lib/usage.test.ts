import { AgentId, type HobUsage, type PlanUsage } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { billingOf, dailyUsage, headlineMeter, hobShares, leftOf, localDay, refillOf } from "./usage.ts";

const row = (hob: string, model: string, tokens: number, replies = 1, unreported = 0): HobUsage => ({
  hobId: AgentId.make(hob),
  hobName: hob,
  hobStatus: "active",
  runtime: "claude-code",
  model,
  replies,
  unreported,
  inputTokens: tokens / 2,
  outputTokens: tokens / 4,
  cacheReadTokens: tokens / 4,
  cacheWriteTokens: 0,
});

describe("usage", () => {
  it("adds each hob's brains up and gives its share of every hob's tokens, most first", () => {
    const shares = hobShares([
      row("pip", "sonnet", 200, 2),
      row("bramble", "opus", 600),
      row("pip", "opus", 200, 3, 1),
    ]);
    expect(
      shares.map(({ hobId, share, tokens, replies, unreported }) => ({ hobId, share, tokens, replies, unreported })),
    ).toEqual([
      { hobId: "bramble", share: 60, tokens: 600, replies: 1, unreported: 0 },
      { hobId: "pip", share: 40, tokens: 400, replies: 5, unreported: 1 },
    ]);
    // A tie in tokens puts the brain with more replies first.
    expect(shares[1]?.brains.map((brain) => brain.model)).toEqual(["opus", "sonnet"]);
    expect(shares[1]).toMatchObject({ inputTokens: 200, outputTokens: 100 });
  });

  it("gives every hob a share of nothing when no reply reported tokens", () => {
    expect(hobShares([row("pip", "sonnet", 0, 2, 2)]).map((hob) => hob.share)).toEqual([0]);
    expect(hobShares([])).toEqual([]);
  });

  it("counts the period's hours into the reader's own days, keeping empty days", () => {
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const days = dailyUsage(
      [
        { hour: at(27, 9), replies: 1, tokens: 10 },
        { hour: at(29, 0), replies: 2, tokens: 20 },
        { hour: at(29, 23), replies: 1, tokens: 5 },
        // Before the period's first day.
        { hour: at(20, 12), replies: 9, tokens: 90 },
      ],
      at(29, 23),
      3,
    );
    expect(days).toEqual([
      { day: "2026-10-27", replies: 1, tokens: 10 },
      { day: "2026-10-28", replies: 0, tokens: 0 },
      { day: "2026-10-29", replies: 3, tokens: 25 },
    ]);
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("shows the meter the provider picked, and how much of it is left", () => {
    const meter = (kind: string, percent: number, active: boolean) => ({
      kind,
      group: kind,
      percent,
      resetsAt: null,
      scope: null,
      severity: "normal",
      active,
    });
    const plan: PlanUsage = {
      runtime: "claude-code",
      reported: true,
      meters: [meter("session", 30, false), meter("weekly_all", 75, true)],
      extraUsage: null,
      checkedAt: null,
    };
    expect(headlineMeter(plan)?.kind).toBe("weekly_all");
    expect(headlineMeter({ ...plan, meters: [meter("session", 30, false)] })?.kind).toBe("session");
    expect(headlineMeter({ ...plan, meters: [] })).toBeUndefined();
    expect([leftOf(meter("a", 75, true)), leftOf(meter("a", 120, true))]).toEqual([0.25, 0]);
  });

  it("reads how a runtime bills from its health", () => {
    expect(["subscription (max)", "fake", "api-key (user)", "api (Claude API)", null].map(billingOf)).toEqual([
      "subscription",
      "subscription",
      "apiKey",
      "apiKey",
      "unknown",
    ]);
  });

  it("says when a window refills in minutes, hours, or by its day", () => {
    const now = new Date("2026-11-03T12:00:00.000Z");
    expect(refillOf("2026-11-03T12:20:00.000Z", now)).toEqual({ in: "minute", value: 20 });
    expect(refillOf("2026-11-03T14:20:00.000Z", now)).toEqual({ in: "hour", value: 2 });
    expect(refillOf("2026-11-07T12:00:00.000Z", now)).toEqual({ on: "2026-11-07T12:00:00.000Z" });
    expect(refillOf("2026-11-03T11:00:00.000Z", now)).toEqual({ now: true });
  });
});
