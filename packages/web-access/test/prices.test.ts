import { describe, expect, it } from "vitest";
import { pricedWebUsage, WEB_SEARCH_PRICES_USD } from "../src/index.ts";

// The estimated cost of web search (ADR 036, Usage and limits, #1269).

const count = { searches: 3, pages: 2, bytes: 900, tokens: 40 } as const;

describe("the web search price table", () => {
  // covers ADR 036 (Cost)
  it("[TC-PE-1269-05] estimates a cost only for searches billed per search, at the provider's published price", () => {
    expect(WEB_SEARCH_PRICES_USD["claude-code"]).toBe(0.01);
    expect(pricedWebUsage({ ...count, billed: [{ runtime: "claude-code", count: 2 }] })).toEqual({
      ...count,
      billedSearches: 2,
      estimatedCostUsd: 0.02,
    });
    // A subscription is not billed per search: counts, never money.
    expect(pricedWebUsage({ ...count, billed: [] }).estimatedCostUsd).toBeNull();
    // A runtime with no published price shows no guess.
    expect(pricedWebUsage({ ...count, billed: [{ runtime: "codex", count: 1 }] })).toMatchObject({
      billedSearches: 1,
      estimatedCostUsd: null,
    });
  });
});
