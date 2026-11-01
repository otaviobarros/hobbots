import { AgentId, ApprovalId, ApprovalRequest, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  expiryText,
  groupByThread,
  isInboxTab,
  pendingCount,
  selectedRequest,
  statusText,
  tabRequests,
  verdictText,
} from "./inbox-items.ts";

const now = new Date("2026-11-01T10:00:00.000Z");

const request = (
  id: string,
  state: ApprovalRequest["state"],
  { thread = "t1", lifetime = null }: { thread?: string; lifetime?: ApprovalRequest["lifetime"] } = {},
) =>
  new ApprovalRequest({
    id: ApprovalId.make(id),
    agentId: AgentId.make("pip"),
    threadId: ThreadId.make(thread),
    messageId: MessageId.make("m1"),
    stepId: "tool-1",
    tool: "Bash",
    operation: "push",
    targets: ["origin feature"],
    arguments: { command: "git push origin feature" },
    label: "Push your work",
    reason: "Pushing asks first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1",
    state,
    lifetime,
    denyReason: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    expiresAt: "2026-11-02T09:00:00.000Z",
    decidedAt: state === "pending" ? null : "2026-11-01T09:30:00.000Z",
  });

describe("tabRequests", () => {
  const all = [request("a", "expired"), request("b", "pending"), request("c", "approved"), request("d", "pending")];

  it("lists only pending requests in Needs you, oldest first", () => {
    expect(tabRequests(all, "needs").map((r) => r.id)).toEqual(["b", "d"]);
    expect(pendingCount(all)).toBe(2);
  });

  it("lists History by when each request was decided or expired, the latest first", () => {
    const early = new ApprovalRequest({ ...request("x", "denied"), decidedAt: "2026-11-01T09:10:00.000Z" });
    const late = new ApprovalRequest({ ...request("y", "approved"), decidedAt: "2026-11-01T09:50:00.000Z" });
    expect(tabRequests([late, early], "history").map((r) => r.id)).toEqual(["y", "x"]);
  });

  it("keeps the request the user is looking at in Needs you once it is decided", () => {
    expect(tabRequests(all, "needs", "c").map((r) => r.id)).toEqual(["b", "c", "d"]);
  });

  it("lists everything newest first in All, and only closed requests in History", () => {
    expect(tabRequests(all, "all").map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
    expect(tabRequests(all, "history").map((r) => r.id)).toEqual(["c", "a"]);
  });
});

describe("groupByThread", () => {
  it("groups requests by thread in the order their first request appears", () => {
    const groups = groupByThread([
      request("a", "pending", { thread: "t2" }),
      request("b", "pending", { thread: "t1" }),
      request("c", "pending", { thread: "t2" }),
    ]);
    expect(groups.map((g) => [g.threadId, g.requests.map((r) => r.id)])).toEqual([
      ["t2", ["a", "c"]],
      ["t1", ["b"]],
    ]);
  });
});

describe("statusText and expiryText", () => {
  it("says how long a pending request has left", () => {
    expect(statusText(request("a", "pending"), now)).toBe("Waiting on you · expires in 23 hours");
    expect(expiryText("2026-11-01T10:42:30.000Z", now)).toBe("expires in 42 minutes");
    expect(expiryText("2026-11-01T10:00:20.000Z", now)).toBe("expires in under a minute");
    expect(expiryText(null, now)).toBe("");
  });

  it("says how a closed request ended", () => {
    expect(statusText(request("a", "approved", { lifetime: "once" }), now)).toBe("You allowed this");
    expect(statusText(request("a", "approved", { lifetime: "always" }), now)).toBe("You allowed this always");
    expect(statusText(request("a", "denied"), now)).toBe("You denied this");
    expect(statusText(request("a", "expired"), now)).toBe("Expired · nothing ran");
  });

  it("names the verdict in History, once for requests from before lifetimes", () => {
    expect(verdictText(request("a", "approved"))).toBe("Once");
    expect(verdictText(request("a", "approved", { lifetime: "always" }))).toBe("Always");
    expect(verdictText(request("a", "denied"))).toBe("Denied");
    expect(verdictText(request("a", "expired"))).toBe("Expired");
  });
});

describe("selectedRequest and isInboxTab", () => {
  it("shows the request the address names when the tab lists it, otherwise the first", () => {
    const listed = [request("a", "pending"), request("b", "pending")];
    expect(selectedRequest(listed, "b")?.id).toBe("b");
    expect(selectedRequest(listed, "gone")?.id).toBe("a");
    expect(selectedRequest(listed, undefined)?.id).toBe("a");
    expect(selectedRequest([], "a")).toBeUndefined();
  });

  it("accepts only the three tabs", () => {
    expect(["needs", "all", "history", "other", 3].map(isInboxTab)).toEqual([true, true, true, false, false]);
  });
});
