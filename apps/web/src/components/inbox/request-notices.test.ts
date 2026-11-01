import { AgentId, ApprovalId, ApprovalRequest, type HobbotsEvent, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { noticeChange, requestNotice } from "./request-notices.ts";

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

const requested = (approval: ApprovalRequest): HobbotsEvent => ({ _tag: "ApprovalRequested", approval });

describe("noticeChange", () => {
  it("shows a request that arrives waiting for you", () => {
    const asked = request("a", "pending");
    expect(noticeChange(requested(asked), asked)).toEqual({ show: asked });
    expect(noticeChange(requested(asked), undefined)).toEqual({ show: asked });
  });

  it("does not show a request replayed after it was decided", () => {
    const asked = request("a", "pending");
    expect(noticeChange(requested(asked), request("a", "approved"))).toEqual({ close: "a" });
  });

  it("closes the notification once the request is decided", () => {
    expect(noticeChange({ _tag: "ApprovalResolved", approval: request("a", "denied") }, undefined)).toEqual({
      close: "a",
    });
  });

  it("ignores other events", () => {
    expect(
      noticeChange({ _tag: "TurnStopped", threadId: ThreadId.make("t1"), messageId: MessageId.make("m1") }, undefined),
    ).toBeUndefined();
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
