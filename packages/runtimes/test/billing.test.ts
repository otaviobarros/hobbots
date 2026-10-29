import { describe, expect, it } from "vitest";
import { billingFrom, isSignedOut } from "../src/claude-code.ts";

describe("billingFrom", () => {
  it("flags API keys and API accounts, and recognizes subscription plans", () => {
    expect(billingFrom("ANTHROPIC_API_KEY")).toBe("api-key (ANTHROPIC_API_KEY)");
    expect(billingFrom("none", "max")).toBe("subscription (max)");
    expect(billingFrom(undefined, "Claude API")).toBe("api (Claude API)");
    expect(billingFrom("none")).toBe("subscription");
  });
});

describe("isSignedOut", () => {
  it("recognizes Claude Code with no login and no API key, as accountInfo reports it", () => {
    expect(isSignedOut({ tokenSource: "none", apiProvider: "firstParty" })).toBe(true);
    expect(isSignedOut({})).toBe(true);
  });

  it("accepts a claude.ai login, an API key or a provider that signs in elsewhere", () => {
    expect(isSignedOut({ email: "me@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" })).toBe(
      false,
    );
    expect(isSignedOut({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" })).toBe(false);
    expect(isSignedOut({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" })).toBe(false);
    expect(isSignedOut({ apiProvider: "bedrock" })).toBe(false);
  });
});
