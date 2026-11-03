import { formatCompact, formatCount, formatDay, formatIn, formatPercent, plural } from "../../lib/format.ts";
import type { Refill } from "../../lib/usage.ts";

/** User-facing copy for the Usage screen (STD-I18N-001). */
export const messages = {
  title: "Usage",
  intro: "Your hobs run on your own AI plans and keys. Here's how much is left and who used it.",
  period: {
    label: "Period",
    7: "7 days",
    30: "30 days",
    last: { 7: "the last 7 days", 30: "the last 30 days" },
  },
  failed: "Hobbots could not read your usage. Try again in a moment.",
  retry: "Try again",
  plans: {
    label: "Your AI plans",
    manage: "Manage providers",
    picker: "Provider",
    checking: "Checking…",
    potion: ({ name, state }: { name: string; state: string }) => `${name}, ${state}`,
    left: ({ percent }: { percent: number }) => `${formatPercent(percent)} left`,
    leftUnit: "left",
    subscription: "Subscription",
    apiKey: "API key",
    connected: "Connected",
    notReported: "Not reported",
    unavailable: "Not connected",
    refill: (refill: Refill) =>
      "now" in refill
        ? "This window refills now."
        : "in" in refill
          ? `This window refills ${formatIn(refill.value, refill.in)}.`
          : `This window refills on ${formatDay(refill.on)}.`,
    noRefill: "The provider didn't say when this window refills.",
    meterUsed: ({ label, percent }: { label: string; percent: number }) => `${label} · ${formatPercent(percent)} used`,
    meterResets: (refill: Refill) =>
      "now" in refill
        ? "Refills now"
        : "in" in refill
          ? `Refills ${formatIn(refill.value, refill.in)}`
          : `Refills on ${formatDay(refill.on)}`,
    meter: {
      session: "Current session",
      weekly_all: "Weekly · all models",
      weekly_scoped: ({ scope }: { scope: string }) => `Weekly · ${scope}`,
      other: ({ name }: { name: string }) => `Plan limit · ${name}`,
    } as const,
    credits: ({ used, limit }: { used: string; limit: string | null }) =>
      limit === null ? `Usage credits: ${used} spent this month.` : `Usage credits: ${used} of ${limit} this month.`,
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
