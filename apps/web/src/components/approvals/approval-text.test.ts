import { AgentId, ApprovalId, ApprovalRequest, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import { decisionErrorText, expiryText, resultText } from "./approval-text.ts";

const request = (fields: Partial<ApprovalRequest> = {}) =>
  new ApprovalRequest({
    id: ApprovalId.make("a1"),
    agentId: AgentId.make("pip"),
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    stepId: "s1",
    tool: "Bash",
    operation: "push",
    targets: ["origin main"],
    arguments: { command: "git push origin main", description: "Push" },
    label: "Running git push origin main",
    reason: "The Balanced preset asks before pushing.",
    actionDigest: "d1",
    policyVersion: "p1",
    state: "pending",
    denyReason: null,
    createdAt: "2026-10-31T12:00:00.000Z",
    decidedAt: null,
    revision: 1,
    ...fields,
  });

describe("resultText", () => {
  it("says how the request ended, with the deny reason when there is one", () => {
    expect(resultText(request({ state: "approved" }), "Pip")).toBe("✓ Allowed once. Pip carries on.");
    expect(resultText(request({ state: "approved", lifetime: "always" }), "Pip")).toBe(
      "✓ Allowed, and the rule is saved. Pip carries on.",
    );
    expect(resultText(request({ state: "denied" }), "Pip")).toBe("✕ Denied. Pip was told it may not.");
    expect(resultText(request({ state: "denied", denyReason: "Not on Fridays" }), "Pip")).toBe(
      "✕ Denied: “Not on Fridays”. Pip was told why.",
    );
    expect(resultText(request({ state: "expired" }), "Pip")).toBe("◷ Expired before anyone decided. Nothing ran.");
  });
});

describe("expiryText", () => {
  it("says when a pending request expires, today or tomorrow", () => {
    const now = new Date(2026, 9, 31, 9, 0);
    const later = new Date(2026, 9, 31, 21, 30).toISOString();
    const tomorrow = new Date(2026, 10, 1, 8, 15).toISOString();
    expect(expiryText(request({ expiresAt: later }), now)).toMatch(/^Expires at .+ if nobody decides/);
    expect(expiryText(request({ expiresAt: tomorrow }), now)).toMatch(/^Expires tomorrow at .+ if nobody decides/);
    expect(expiryText(request({ expiresAt: new Date(2026, 9, 31, 8, 0).toISOString() }), now)).toBe(
      "Expiring now. Nobody decided in time.",
    );
    expect(expiryText(request({ expiresAt: null }), now)).toBe("Expires if this reply stops or Hobbots restarts.");
  });
});

describe("decisionErrorText", () => {
  it("tells a closed or changed request from a failed send", () => {
    expect(decisionErrorText(new ApiError("", "ApprovalClosed"))).toMatch(/already decided/);
    expect(decisionErrorText(new ApiError("", "ApprovalActionChanged"))).toMatch(/changed/);
    expect(decisionErrorText(new ApiError("", "GrantRuleRefused"))).toMatch(/could not save this rule/);
    expect(decisionErrorText(new Error("offline"))).toMatch(/could not send/);
  });
});
