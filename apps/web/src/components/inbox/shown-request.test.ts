import { AgentId, ApprovalId, ApprovalRequest, INBOX_HISTORY, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { inboxWindow } from "../../api/inbox-window.ts";
import { selectedRequest, tabRequests } from "./inbox-items.ts";
import { withShown } from "./shown-request.ts";

const at = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString();

const request = (n: number, state: ApprovalRequest["state"]) =>
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
    decidedAt: state === "pending" ? null : at(n),
  });

describe("withShown", () => {
  it("keeps the open request in view when a decision elsewhere pushes it out of History", () => {
    const closed = Array.from({ length: INBOX_HISTORY }, (_, n) => request(n, "denied"));
    const pending = request(500, "pending");
    const oldest = closed[0];
    // The user opens the oldest closed request in All.
    const before = inboxWindow([...closed, pending]);
    expect(selectedRequest(tabRequests(before, "all"), oldest?.id)).toBe(oldest);

    // Another request is decided elsewhere: the window drops the oldest closed one.
    const after = inboxWindow([...closed, new ApprovalRequest({ ...pending, state: "approved", decidedAt: at(600) })]);
    expect(after.some((r) => r.id === oldest?.id)).toBe(false);

    const shown = withShown(after, oldest, oldest?.id);
    const all = tabRequests(shown, "all");
    expect(selectedRequest(all, oldest?.id)).toBe(oldest);
    expect(all.at(-1)).toBe(oldest);
  });

  it("[TC-IN-009] shows the request as the hub has it now when a fresh snapshot leaves it out", () => {
    const closed = Array.from({ length: INBOX_HISTORY }, (_, n) => request(n + 1000, "denied"));
    const selected = request(500, "pending");
    // The user had the pending request open; it was decided while the client was away, and the
    // fresh list no longer holds it, since newer decisions fill History.
    const snapshot = inboxWindow([
      ...closed,
      new ApprovalRequest({ ...selected, state: "approved", decidedAt: at(600) }),
    ]);
    expect(snapshot.some((r) => r.id === selected.id)).toBe(false);

    const fresh = new ApprovalRequest({ ...selected, state: "approved", decidedAt: at(600), revision: 2 });
    const shown = tabRequests(withShown(snapshot, fresh, selected.id), "all", selected.id);
    expect(selectedRequest(shown, selected.id)).toBe(fresh);
    expect(shown.some((r) => r.state === "pending")).toBe(false);
  });

  it("adds nothing once another request is picked, or when the open one is still listed", () => {
    const listed = [request(1, "denied"), request(2, "pending")];
    const gone = request(0, "expired");
    expect(withShown(listed, gone, "r0002")).toBe(listed);
    expect(withShown(listed, listed[0], "r0001")).toBe(listed);
    expect(withShown(listed, undefined, "r0000")).toBe(listed);
  });
});
