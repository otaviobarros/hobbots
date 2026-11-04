import { RuntimeHealth } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { enforcementFixture } from "../../test/enforcement.ts";
import { accountLine, hobsLine } from "./provider-lines.ts";

const health = (fields: Partial<RuntimeHealth>) =>
  new RuntimeHealth({
    runtime: "claude-code",
    availability: "ready",
    billing: "subscription (max)",
    version: "2.4.0",
    detail: null,
    checkedAt: null,
    enforcement: enforcementFixture(),
    ...fields,
  });

describe("the account line", () => {
  it("names the plan a subscription reports", () => {
    expect(accountLine(health({}))).toBe("Signed in · Max plan");
    expect(accountLine(health({ runtime: "codex", billing: "subscription (plus)" }))).toBe("Signed in · Plus plan");
  });

  it("says a subscription or an API key when no plan is named", () => {
    expect(accountLine(health({ billing: "subscription" }))).toBe("Signed in with your subscription");
    expect(accountLine(health({ billing: "api-key (ANTHROPIC_API_KEY)" }))).toBe("Signed in with an API key");
  });

  it("says nothing when the provider is not ready or reports no billing", () => {
    expect(accountLine(health({ availability: "signedOut" }))).toBeNull();
    expect(accountLine(health({ billing: null }))).toBeNull();
    expect(accountLine(undefined)).toBeNull();
  });
});

describe("the hobs line", () => {
  const claude = { runtime: "claude-code" } as const;
  const codex = { runtime: "codex" } as const;

  it("counts the hobs that think with a provider", () => {
    expect(hobsLine("claude-code", "Claude Code", [claude, claude, claude])).toMatch(
      /^All 3 hobs think with Claude Code\./,
    );
    expect(hobsLine("claude-code", "Claude Code", [claude])).toMatch(/^Your hob thinks with Claude Code\./);
    expect(hobsLine("codex", "Codex", [claude, codex, claude])).toMatch(/^1 of 3 hobs think with Codex\./);
    expect(hobsLine("codex", "Codex", [claude])).toBe("No hob thinks with Codex yet. Pick it in a hob's profile.");
  });
});
