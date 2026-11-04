import {
  formatCompact,
  formatCount,
  formatDay,
  formatIn,
  formatPercent,
  formatTime,
  formatWeekdayTime,
  plural,
} from "../../lib/format.ts";
import type { Refill } from "../../lib/usage.ts";

/** User-facing copy for the Usage screen (STD-I18N-001). */
export const messages = {
  title: "Usage",
  intro: "How much of your AI plan your hobs have used, and on what.",
  period: {
    label: "Period",
    7: "Last 7 days",
    30: "30 days",
    last: { 7: "the last 7 days", 30: "the last 30 days" },
  },
  failed: "Hobbots could not read your usage. Try again in a moment.",
  retry: "Try again",
  plans: {
    label: "Your AI",
    manage: "Manage providers",
    picker: "Provider",
    checking: "Checking…",
    plan: ({ name }: { name: string }) => `${name} plan`,
    left: ({ percent }: { percent: number }) => `${formatPercent(percent)} left`,
    empty: "Empty",
    subscription: "Subscription",
    apiKey: "API key",
    connected: "Connected",
    notReported: "Not reported",
    unavailable: "Not connected",
    refill: (refill: Refill, at: string) =>
      "now" in refill
        ? "Refills now."
        : "in" in refill
          ? `Refills ${formatIn(refill.value, refill.in)}, at ${formatTime(at)}.`
          : `Refills ${formatWeekdayTime(at)}.`,
    refillShort: (refill: Refill, at: string) =>
      "now" in refill
        ? "refills now"
        : "in" in refill
          ? `refills ${formatTime(at)}`
          : `refills ${formatWeekdayTime(at)}`,
    noRefill: "The provider didn't say when this refills.",
    meter: {
      session: "This session",
      weekly_all: "This week",
      weekly_scoped: ({ scope }: { scope: string }) => `This week · ${scope}`,
      other: ({ name }: { name: string }) => `Plan limit · ${name}`,
    } as const,
    credits: ({ used, limit }: { used: string; limit: string | null }) =>
      limit === null ? `Usage credits: ${used} spent this month.` : `Usage credits: ${used} of ${limit} this month.`,
    checked: ({ name, ago }: { name: string; ago: string }) => `Numbers from ${name}, checked ${ago}.`,
    subscriptionUnreported: ({ name }: { name: string }) =>
      `${name} didn't report this plan's limits, so Hobbots shows none. They appear here once it does.`,
    apiKeyUnreported: ({ name }: { name: string }) =>
      `${name} uses an API key on this hub. It doesn't report what the key spent, so Hobbots shows no cost.`,
    unknownUnreported: ({ name }: { name: string }) =>
      `${name} doesn't report its plan, so Hobbots shows nothing for it.`,
    notConnected: ({ name }: { name: string }) =>
      `${name} isn't ready on this hub. Settings says why and how to fix it.`,
  },
  daily: {
    label: "Replies per day",
    total: ({ count, period }: { count: number; period: string }) =>
      plural(count, {
        one: `1 reply in ${period}`,
        other: `${formatCount(count)} replies in ${period}`,
      }),
    day: ({ day, replies, tokens }: { day: string; replies: number; tokens: number }) =>
      plural(replies, {
        one: `${day}: 1 reply, ${formatCompact(tokens)} tokens`,
        other: `${day}: ${formatCount(replies)} replies, ${formatCompact(tokens)} tokens`,
      }),
    today: "Today",
  },
  hobs: {
    label: "Who used your plans",
    empty: ({ period }: { period: string }) => `No hob replied in ${period}.`,
    retired: "Retired",
    share: ({ share, tokens }: { share: number; tokens: number }) =>
      `${formatPercent(share)} · ${formatCompact(tokens)} tokens`,
    replies: ({ count }: { count: number }) =>
      plural(count, { one: "1 reply", other: `${formatCount(count)} replies` }),
    unreported: ({ count }: { count: number }) =>
      plural(count, {
        one: "1 reply didn't report its usage.",
        other: `${formatCount(count)} replies didn't report their usage.`,
      }),
    brain: ({ runtime, model }: { runtime: string; model: string | null }) =>
      model === null ? runtime : `${runtime} · ${model}`,
    earlierBrain: "An earlier brain",
    tokens: ({ input, output }: { input: number; output: number }) =>
      `${formatCompact(input)} in, ${formatCompact(output)} out, the rest read from or written to the cache`,
  },
  note: "Counts chat replies with the tokens each provider reported for them, cache reads included. Task steps aren't counted yet.",
};
