import type { WebUsageCount } from "@hobbots/agents";
import type { RuntimeKind, WebUsageTotals } from "@hobbots/domain";

/**
 * What one web search costs where a sign-in is billed per search (ADR 036, Usage and limits), in US
 * dollars, before the tokens its results add. Only a price a provider publishes is here: Anthropic
 * bills $10 per 1,000 searches on the Claude API. Codex's sign-in through Hobbots is a ChatGPT plan,
 * which is not billed per search, so it has no price; a runtime without one shows counts, not money.
 */
export const WEB_SEARCH_PRICES_USD: Readonly<Record<RuntimeKind, number | null>> = {
  "claude-code": 10 / 1000,
  codex: null,
};

/**
 * The totals with their estimated cost: null when no search was billed per search, or when a billed
 * runtime has no price, so a subscription never shows money and an unknown price never shows a guess.
 */
export const pricedWebUsage = (
  count: WebUsageCount,
  prices: Readonly<Record<RuntimeKind, number | null>> = WEB_SEARCH_PRICES_USD,
): WebUsageTotals => {
  const billedSearches = count.billed.reduce((sum, billed) => sum + billed.count, 0);
  const costs = count.billed.map((billed) => {
    const price = prices[billed.runtime];
    return price === null ? null : price * billed.count;
  });
  const estimatedCostUsd =
    billedSearches === 0 || costs.some((cost) => cost === null)
      ? null
      : Math.round(costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) * 1_000_000) / 1_000_000;
  return {
    searches: count.searches,
    pages: count.pages,
    bytes: count.bytes,
    tokens: count.tokens,
    billedSearches,
    estimatedCostUsd,
  };
};
