import { AgentId, ApprovalId, ApprovalRequest, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { freshRequests, requestNotice } from "./request-notices.ts";

const request = (id: string, state: ApprovalRequest["state"], command = "git push origin feature") =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId: AgentId.make("pip"),
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    stepId: "tool-1",
    tool: "Bash",
    operation: "push",
    targets: [],
    arguments: { command },
    label: "Push",
    reason: "Pushing asks first.",
    actionDigest: "d",
    policyVersion: "r1",
    state,
    denyReason: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    decidedAt: state === "pending" ? null : "2026-11-01T10:01:00.000Z",
  });

describe("freshRequests", () => {
  it("announces nothing on the first read, which only learns what already waits", () => {
    const first = freshRequests(undefined, [request("a", "pending")]);
    expect(first.fresh).toEqual([]);
    expect([...first.seen]).toEqual(["a"]);
  });

  it("announces each new pending request once", () => {
    const { seen } = freshRequests(undefined, [request("a", "pending")]);
    const next = freshRequests(seen, [request("a", "pending"), request("b", "pending"), request("c", "denied")]);
    expect(next.fresh.map((approval) => approval.id)).toEqual(["b"]);
    expect(freshRequests(next.seen, [request("b", "pending")]).fresh).toEqual([]);
  });

  it("does not announce a request again after it is decided", () => {
    const { seen } = freshRequests(new Set(), [request("a", "pending")]);
    expect(freshRequests(seen, [request("a", "approved")]).fresh).toEqual([]);
  });
});

describe("requestNotice", () => {
  it("says who asks and the exact action", () => {
    expect(requestNotice(request("a", "pending"), "Pip")).toEqual({
      title: "Pip asks permission",
      body: "Push your work: git push origin feature",
    });
  });

  it("keeps a long action short enough for the system", () => {
    const { body } = requestNotice(request("a", "pending", `echo ${"x".repeat(400)}`), "Pip");
    expect(body.length).toBeLessThan(160);
    expect(body.endsWith("…")).toBe(true);
  });
});
