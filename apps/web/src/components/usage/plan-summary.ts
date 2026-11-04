import type { PlanMeter, PlanUsage, RuntimeKind } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { usageQuery } from "../../api/queries.ts";
import { leftOf, localDay, type PlanLevel, planLevel, refillOf } from "../../lib/usage.ts";
import { messages } from "./messages.ts";

// One source for a plan's numbers (#554). The Usage screen, Home's plan line and a chat reply the
// limit stopped all read the plan the hub reported with the Usage report, and say it in the same words.

const copy = messages.plans;

/** Every provider's plan, from the Usage report for the last 7 days: the same request the Usage screen makes. */
export const usePlans = (): ReadonlyArray<PlanUsage> | undefined =>
  useQuery({ ...usageQuery("7", localDay(new Date())), select: (report) => report.plans }).data;

/** A window's name in words: This session, This week. */
export const windowName = (meter: PlanMeter): string => {
  if (meter.kind === "session") return copy.meter.session;
  if (meter.kind === "weekly_all") return copy.meter.weekly_all;
  if (meter.kind === "weekly_scoped" && meter.scope !== null) return copy.meter.weekly_scoped({ scope: meter.scope });
  return copy.meter.other({ name: meter.scope ?? meter.group });
};

/** What is left of a window: "62% left", or Empty. */
export const leftText = (meter: PlanMeter): string =>
  meter.percent >= 100 ? copy.empty : copy.left({ percent: Math.round(leftOf(meter) * 100) });

/** When a window refills, as a sentence: "Refills in 2 hours, at 4:10 PM." */
export const refillSentence = (resetsAt: string | null, now: Date): string =>
  resetsAt === null ? copy.noRefill : copy.refill(refillOf(resetsAt, now), resetsAt);

/** What a plan says in one line, and how full its potion is, or null when it reported no window. */
export interface PlanSummary {
  readonly level: PlanLevel;
  /** What is left of the window that sets the level, 0 to 1. */
  readonly left: number;
  /** "62% left · This week · refills Monday, Nov 9, 9:00 AM". */
  readonly line: string;
}

export const planSummary = (plan: PlanUsage | undefined, now: Date): PlanSummary | null => {
  const worst = plan === undefined ? undefined : planLevel(plan);
  if (worst === undefined) return null;
  const { level, meter } = worst;
  const parts = [leftText(meter), windowName(meter)];
  if (meter.resetsAt !== null) parts.push(copy.refillShort(refillOf(meter.resetsAt, now), meter.resetsAt));
  return { level, left: leftOf(meter), line: parts.join(" · ") };
};

/** The plan a runtime reported, if it did. */
export const planOf = (plans: ReadonlyArray<PlanUsage> | undefined, runtime: RuntimeKind): PlanUsage | undefined =>
  plans?.find((plan) => plan.runtime === runtime);

/**
 * When a reply the limit stopped can carry on. A plan that reports a used-up window says when it
 * refills, as the Usage screen does; otherwise the time the provider sent with the stopped reply.
 */
export const limitRefill = (plan: PlanUsage | undefined, stoppedUntil: string | null, now: Date): string => {
  const worst = plan === undefined ? undefined : planLevel(plan);
  return refillSentence(worst?.level === "out" ? worst.meter.resetsAt : stoppedUntil, now);
};
