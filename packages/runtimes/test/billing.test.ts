import { describe, expect, it } from "vitest";
import { billingFrom } from "../src/claude-code.ts";

describe("billingFrom", () => {
  it("flags API keys and API accounts, and recognizes subscription plans", () => {
    expect(billingFrom("ANTHROPIC_API_KEY")).toBe("api-key (ANTHROPIC_API_KEY)");
    expect(billingFrom("none", "max")).toBe("subscription (max)");
    expect(billingFrom(undefined, "Claude API")).toBe("api (Claude API)");
    expect(billingFrom("none")).toBe("subscription");
  });
});
