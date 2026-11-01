import { AgentId, ApprovalId, ApprovalRequest, INBOX_HISTORY, MessageId, ThreadId } from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { inboxQuery, storeApproval } from "./approvals.ts";
import { inboxWindow } from "./inbox-window.ts";

const at = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString();

const request = (n: number, state: ApprovalRequest["state"], decided = n) =>
  new ApprovalRequest({
    id: ApprovalId.make(`r${String(n).padStart(4, "0")}`),
    agentId: AgentId.make("pip"),
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    stepId: "tool-1",
    tool: "Bash",
    operation: "push",
    targets: [],
    arguments: {},
    label: "Push",
    reason: "Pushing asks first.",
    actionDigest: "d",
    policyVersion: "r1",
    state,
    denyReason: null,
    createdAt: at(n),
    decidedAt: state === "pending" ? null : at(decided),
  });

const closed = (count: number) => Array.from({ length: count }, (_, n) => request(n, "denied"));

describe("inboxWindow", () => {
  it("keeps every pending request and the most recently closed ones, oldest first", () => {
    const old = request(-1, "pending");
    // The oldest closed request was decided last, so it stays and the next oldest goes.
    const lateDecision = request(0, "expired", 10_000);
    const all = [old, lateDecision, ...closed(INBOX_HISTORY + 1).slice(1)];
    const kept = inboxWindow(all);
    expect(kept).toHaveLength(INBOX_HISTORY + 1);
    expect(kept.map((r) => r.id).slice(0, 3)).toEqual(["r00-1", "r0000", "r0002"]);
  });
});

describe("storeApproval on the Inbox", () => {
  // covers PE-003
  it("[TC-IN-005] a decision arriving live never grows History past its window", () => {
    const client = new QueryClient();
    const pending = request(500, "pending");
    client.setQueryData(inboxQuery.queryKey, [...closed(INBOX_HISTORY), pending]);
    storeApproval(client, new ApprovalRequest({ ...pending, state: "approved", decidedAt: at(600), revision: 2 }));
    const inbox = client.getQueryData<ReadonlyArray<ApprovalRequest>>(inboxQuery.queryKey) ?? [];
    expect(inbox).toHaveLength(INBOX_HISTORY);
    expect(inbox.at(-1)?.id).toBe("r0500");
    expect(inbox.some((r) => r.id === "r0000")).toBe(false);
  });
});
