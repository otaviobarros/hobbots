import {
  type AgentId,
  type AgentStatus,
  type HobUsage,
  type MinuteUsage,
  type PlanMeter,
  type PlanUsage,
  type RuntimeKind,
  UsagePeriod,
  usageTokens,
} from "@hobbots/domain";
import { Schema } from "effect";

/** Whether a search param names one of the Usage screen's periods. */
export const isUsagePeriod = Schema.is(UsagePeriod);

// The Usage screen's arithmetic (OP-002): each hob's share of the period's tokens, the period's
// replies by the reader's own days, and what a plan's headline meter says. Nothing is estimated.

/** What one hob's replies used on one brain. */
export interface BrainShare {
  readonly runtime: RuntimeKind | null;
  readonly model: string | null;
  readonly replies: number;
  readonly tokens: number;
}

/** What one hob's replies used in the period, and its share of every hob's tokens. */
export interface HobShare {
  readonly hobId: AgentId;
  readonly name: string;
  readonly status: AgentStatus;
  readonly replies: number;
  /** Replies whose runtime reported no usage. */
  readonly unreported: number;
  readonly tokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Of every hob's tokens in the period, 0 to 100, rounded. */
  readonly share: number;
  /** Most tokens first. */
  readonly brains: ReadonlyArray<BrainShare>;
}

const byTokens = <T extends { readonly tokens: number; readonly replies: number }>(a: T, b: T) =>
  b.tokens - a.tokens || b.replies - a.replies;

/** Each hob's replies and tokens over the period, most tokens first, with its share of them all. */
export const hobShares = (rows: ReadonlyArray<HobUsage>): ReadonlyArray<HobShare> => {
  const hobs = new Map<AgentId, Omit<HobShare, "share" | "brains"> & { brains: Array<BrainShare> }>();
  for (const row of rows) {
    const tokens = usageTokens(row);
    const hob = hobs.get(row.hobId) ?? {
      hobId: row.hobId,
      name: row.hobName,
      status: row.hobStatus,
      replies: 0,
      unreported: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      brains: [],
    };
    hobs.set(row.hobId, {
      ...hob,
      replies: hob.replies + row.replies,
      unreported: hob.unreported + row.unreported,
      tokens: hob.tokens + tokens,
      inputTokens: hob.inputTokens + row.inputTokens,
      outputTokens: hob.outputTokens + row.outputTokens,
      brains: [...hob.brains, { runtime: row.runtime, model: row.model, replies: row.replies, tokens }],
    });
  }
  const all = [...hobs.values()];
  const shares = wholeShares(all.map((hob) => hob.tokens));
  return all
    .map((hob, index) => ({ ...hob, share: shares[index] ?? 0, brains: hob.brains.toSorted(byTokens) }))
    .toSorted((a, b) => byTokens(a, b) || a.name.localeCompare(b.name));
};

/**
 * Each amount's whole-number share of their sum, out of 100, so the shares add up to exactly 100:
 * every share rounds down, then the largest remainders take the points left over. All zeros when the
 * sum is zero.
 */
export const wholeShares = (amounts: ReadonlyArray<number>): ReadonlyArray<number> => {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total === 0) return amounts.map(() => 0);
  const exact = amounts.map((amount) => (amount / total) * 100);
  const shares = exact.map(Math.floor);
  const leftOver = 100 - shares.reduce((sum, share) => sum + share, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .toSorted((a, b) => b.remainder - a.remainder);
  for (const { index } of byRemainder.slice(0, leftOver)) shares[index] = (shares[index] ?? 0) + 1;
  return shares;
};

/** The day with the most replies, or undefined when no day has any. The latest wins a tie. */
export const busiestDay = (days: ReadonlyArray<DayUsage>): DayUsage | undefined =>
  days.reduce<DayUsage | undefined>(
    (best, day) => (day.replies > 0 && day.replies >= (best?.replies ?? 0) ? day : best),
    undefined,
  );

/** One of the reader's days in the period. `day` is its local date, "2026-11-02". */
export interface DayUsage {
  readonly day: string;
  readonly replies: number;
  readonly tokens: number;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The local date of a time, "2026-11-02", in the reader's time zone. */
export const localDay = (time: Date): string =>
  `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;

/** The start of the reader's own first day of a `days`-day period that ends today. */
export const periodStart = (now: Date, days: number): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));

/**
 * The period's replies and tokens on each of its last `days` local days, oldest first and ending on
 * the day of `until`. Days without replies are kept, at zero.
 */
export const dailyUsage = (
  minutes: ReadonlyArray<MinuteUsage>,
  until: string,
  days: number,
): ReadonlyArray<DayUsage> => {
  const first = periodStart(new Date(until), days);
  const keys = Array.from({ length: days }, (_, index) =>
    localDay(new Date(first.getFullYear(), first.getMonth(), first.getDate() + index)),
  );
  const totals = new Map(keys.map((key) => [key, { replies: 0, tokens: 0 }]));
  for (const minute of minutes) {
    const total = totals.get(localDay(new Date(minute.minute)));
    if (total === undefined) continue;
    total.replies += minute.replies;
    total.tokens += minute.tokens;
  }
  return keys.map((day) => ({ day, ...(totals.get(day) ?? { replies: 0, tokens: 0 }) }));
};

/** The meter a single-value potion shows: the one the provider picked, else its first. */
export const headlineMeter = (plan: PlanUsage): PlanMeter | undefined =>
  plan.meters.find((meter) => meter.active) ?? plan.meters[0];

/**
 * How a plan window stands: `ok`, `low` when little is left, `out` when it is used up and hobs on
 * it pause until it refills. The provider's own warning counts first; from 80% used, a window is
 * low even when the provider didn't warn.
 */
export type PlanLevel = "ok" | "low" | "out";

/** From this much of a window used, it is running low. */
const LOW_FROM_PERCENT = 80;

const LEVEL_RANK: Record<PlanLevel, number> = { ok: 0, low: 1, out: 2 };

export const meterLevel = (meter: PlanMeter): PlanLevel => {
  if (meter.percent >= 100) return "out";
  if (meter.severity === "warning" || meter.severity === "critical" || meter.percent >= LOW_FROM_PERCENT) return "low";
  return "ok";
};

/**
 * A plan's level and the window that sets it: the worst of its windows, and among those the one
 * that refills last, since hobs wait for it. Undefined when the plan reported no window.
 */
export const planLevel = (plan: PlanUsage): { readonly level: PlanLevel; readonly meter: PlanMeter } | undefined => {
  if (!plan.reported) return undefined;
  const headline = headlineMeter(plan);
  if (headline === undefined) return undefined;
  const rank = (meter: PlanMeter) => LEVEL_RANK[meterLevel(meter)];
  const worst = plan.meters.reduce((best, meter) => {
    const difference = rank(meter) - rank(best);
    const refillsLater = (meter.resetsAt ?? "") > (best.resetsAt ?? "");
    return difference > 0 || (difference === 0 && rank(meter) > 0 && refillsLater) ? meter : best;
  }, headline);
  return { level: meterLevel(worst), meter: worst };
};

/** How much of a meter's window is left, 0 to 1. */
export const leftOf = (meter: PlanMeter): number => Math.min(1, Math.max(0, (100 - meter.percent) / 100));

/**
 * The usage credits a plan reported spending this month, in minor units of its currency. Spend shows
 * whether or not credits can pay for requests right now: turning them off after spending does not
 * undo the month's spend.
 */
export const reportedCredits = (
  plan: PlanUsage,
): { readonly used: number; readonly limit: number | null; readonly currency: string } | null => {
  const extra = plan.extraUsage;
  if (extra === null || extra.usedCredits === null) return null;
  return { used: extra.usedCredits, limit: extra.monthlyLimit, currency: extra.currency ?? "USD" };
};

/** How a runtime bills this hub, from what its health reports: a subscription, an API key, or unknown. */
export type Billing = "subscription" | "apiKey" | "unknown";

export const billingOf = (billing: string | null): Billing => {
  if (billing === null) return "unknown";
  if (billing.startsWith("subscription") || billing === "fake") return "subscription";
  if (billing.startsWith("api")) return "apiKey";
  return "unknown";
};

/** When a window refills, relative to `now`: in minutes under an hour, hours under two days, else its day. */
export type Refill =
  | { readonly in: "minute" | "hour"; readonly value: number }
  | { readonly on: string }
  | { readonly now: true };

export const refillOf = (resetsAt: string, now: Date): Refill => {
  const minutes = Math.ceil((new Date(resetsAt).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return { now: true };
  if (minutes < 60) return { in: "minute", value: minutes };
  if (minutes < 48 * 60) return { in: "hour", value: Math.round(minutes / 60) };
  return { on: resetsAt };
};
