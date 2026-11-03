import { AgentId, ApprovalId, ApprovalRequest, DeviceId, MessageId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { deciderText } from "./inbox-items.ts";

// Who decided a request, from which device and where, as History shows it (#598).
const PHONE = DeviceId.make("phone");
const names = (deviceId: DeviceId) => (deviceId === PHONE ? "Safari on iPhone" : "a device");

const closed = (fields: Partial<ConstructorParameters<typeof ApprovalRequest>[0]>) =>
  new ApprovalRequest({
    id: ApprovalId.make("a1"),
    agentId: AgentId.make("nettle"),
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    stepId: "tool-1",
    tool: "Bash",
    operation: "delete-files",
    targets: ["scratch/tmp-notes.txt"],
    arguments: { command: "rm scratch/tmp-notes.txt" },
    label: "Running rm scratch/tmp-notes.txt",
    reason: "Deleting files asks first.",
    actionDigest: "d".repeat(64),
    policyVersion: "r1",
    state: "approved",
    denyReason: null,
    createdAt: "2026-11-03T01:17:52.000Z",
    decidedAt: "2026-11-03T01:18:27.000Z",
    ...fields,
  });

describe("deciderText", () => {
  it("[TC-IN-207] names the decision, the device and where it was made", () => {
    expect(deciderText(closed({ lifetime: "once", decidedByDeviceId: PHONE, decidedVia: "inbox" }), names)).toBe(
      "Allowed once from Safari on iPhone in the Inbox",
    );
    expect(deciderText(closed({ lifetime: "always", decidedByDeviceId: PHONE, decidedVia: "chat" }), names)).toBe(
      "Allowed always from Safari on iPhone in the chat",
    );
    expect(deciderText(closed({ state: "denied", decidedByDeviceId: PHONE, decidedVia: "chat" }), names)).toBe(
      "Denied from Safari on iPhone in the chat",
    );
    expect(deciderText(closed({ decidedByDeviceId: DeviceId.make("gone"), decidedVia: null }), names)).toBe(
      "Allowed once from a device",
    );
  });

  it("[TC-IN-208] says nobody decided an expired request, and nothing for one closed before deciders were recorded", () => {
    expect(deciderText(closed({ state: "expired", decidedVia: "expired" }), names)).toBe(
      "Expired before anyone decided",
    );
    expect(deciderText(closed({}), names)).toBeNull();
    expect(deciderText(closed({ state: "pending", decidedAt: null }), names)).toBeNull();
  });
});
