import { AgentId, Grant, GrantId, Revision } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ruleMeta, standingRules } from "./standing-rules.ts";

const now = new Date("2026-11-01T10:00:00.000Z");

const grant = (id: string, createdAt: string, overrides: Partial<Grant> = {}) =>
  new Grant({
    id: GrantId.make(id),
    agentId: AgentId.make("pip"),
    operation: "use-web",
    rule: { _tag: "Host", host: "example.com" },
    lifetime: "always",
    questId: null,
    approvalId: null,
    grantedBy: "user",
    createdAt,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    revision: Revision.make(1),
    ...overrides,
  });

describe("standingRules", () => {
  it("lists only Always rules, most recently saved first", () => {
    const older = grant("g1", "2026-10-26T09:00:00.000Z");
    const newer = grant("g2", "2026-10-30T09:00:00.000Z");
    const quest = grant("g3", "2026-10-31T09:00:00.000Z", { lifetime: "quest", questId: "q1" });
    expect(standingRules([older, quest, newer]).map((rule) => rule.id)).toEqual(["g2", "g1"]);
  });
});

describe("ruleMeta", () => {
  it("says when the rule was saved and when it last answered a call", () => {
    expect(ruleMeta(grant("g1", "2026-10-26T09:00:00.000Z"), now)).toBe("Saved Oct 26 · not used yet");
    expect(ruleMeta(grant("g1", "2026-10-26T09:00:00.000Z", { lastUsedAt: "2026-10-31T09:00:00.000Z" }), now)).toBe(
      "Saved Oct 26 · last used Oct 31",
    );
  });
});
