import {
  type AgentId,
  type AgentStatus,
  type HobUsage,
  type HourUsage,
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
  const total = [...hobs.values()].reduce((sum, hob) => sum + hob.tokens, 0);
  return [...hobs.values()]
    .map((hob) => ({
      ...hob,
      share: total === 0 ? 0 : Math.round((hob.tokens / total) * 100),
      brains: hob.brains.toSorted(byTokens),
    }))
    .toSorted((a, b) => byTokens(a, b) || a.name.localeCompare(b.name));
};

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

/**
 * The period's replies and tokens on each of its last `days` local days, oldest first and ending on
 * the day of `until`. Days without replies are kept, at zero.
 */
export const dailyUsage = (hours: ReadonlyArray<HourUsage>, until: string, days: number): ReadonlyArray<DayUsage> => {
  const end = new Date(until);
  const keys = Array.from({ length: days }, (_, back) => {
    const day = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1 - back));
    return localDay(day);
  });
  const totals = new Map(keys.map((key) => [key, { replies: 0, tokens: 0 }]));
  for (const hour of hours) {
    const total = totals.get(localDay(new Date(hour.hour)));
    if (total === undefined) continue;
    total.replies += hour.replies;
    total.tokens += hour.tokens;
  }
  return keys.map((day) => ({ day, ...(totals.get(day) ?? { replies: 0, tokens: 0 }) }));
};

/** The meter a single-value potion shows: the one the provider picked, else its first. */
export const headlineMeter = (plan: PlanUsage): PlanMeter | undefined =>
  plan.meters.find((meter) => meter.active) ?? plan.meters[0];

/** How much of a meter's window is left, 0 to 1. */
export const leftOf = (meter: PlanMeter): number => Math.min(1, Math.max(0, (100 - meter.percent) / 100));

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
