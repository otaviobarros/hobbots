import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  BackpackBlocker,
  BackpackDelivery,
  BackpackItem,
  BackpackItemId,
  backpackStep,
  blockerNextAction,
  deliveriesSinceRetry,
  JournaledEvent,
  openBlocker,
} from "../src/index.ts";

const at = "2026-11-02T00:00:00.000Z";

const delivery = (number: number) =>
  new BackpackDelivery({
    number,
    target: "thread:t1",
    turnId: `turn-${number}`,
    deliveredAt: at,
    acknowledgedSessionId: null,
    acknowledgedAt: null,
  });

const blocker = (number: number, afterDeliveries: number, decision: "retry" | "dismiss" | null) =>
  new BackpackBlocker({
    number,
    reason: "retries-exhausted",
    nextAction: "retry",
    diagnostic: "The runtime stopped.",
    lastEnd: "failed",
    afterDeliveries,
    raisedAt: at,
    decision,
    decidedAt: decision === null ? null : at,
  });

const fields = {
  id: BackpackItemId.make("i1"),
  recipientId: AgentId.make("aldric"),
  kind: "message",
  actionable: true,
  priority: 1,
  taskId: null,
  questId: null,
  attemptId: null,
  threadId: null,
  dedupeKey: "i1",
  payload: { _tag: "message", senderId: null, text: "Hi" },
  notBefore: null,
  claim: null,
  fencingToken: 0,
  disposition: null,
  error: null,
  createdAt: at,
  updatedAt: at,
  revision: 1,
} as const;

describe("blockers", () => {
  it("counts an item's deliveries from its last retry, and finds the blocker that waits for a choice", () => {
    const failed = new BackpackItem({
      ...fields,
      state: "failed",
      deliveries: [1, 2, 3, 4, 5].map(delivery),
      blockers: [blocker(1, 3, "retry"), blocker(2, 5, null)],
    });
    expect(deliveriesSinceRetry(failed)).toBe(0);
    expect(openBlocker(failed)?.number).toBe(2);

    const retried = new BackpackItem({
      ...fields,
      state: "pending",
      deliveries: [1, 2, 3, 4].map(delivery),
      blockers: [blocker(1, 3, "retry")],
    });
    expect(deliveriesSinceRetry(retried)).toBe(1);
    expect(openBlocker(retried)).toBeUndefined();
    expect(deliveriesSinceRetry(new BackpackItem({ ...fields, state: "pending", deliveries: [delivery(1)] }))).toBe(1);
  });

  it("suggests retrying exhausted work and dismissing a retired hob's, and moves a failed item only by your choice", () => {
    expect(blockerNextAction("retries-exhausted")).toBe("retry");
    expect(blockerNextAction("recipient-retired")).toBe("dismiss");
    expect(backpackStep("abandon")).toEqual({ from: ["pending"], to: "failed" });
    expect(backpackStep("retry")).toEqual({ from: ["failed"], to: "pending" });
    expect(backpackStep("dismiss")).toEqual({ from: ["failed"], to: "resolved" });
  });

  it("reads an item journaled before blockers existed as having none", () => {
    const { blockers: _, ...old } = Schema.encodeSync(BackpackItem)(
      new BackpackItem({ ...fields, state: "pending", deliveries: [] }),
    );
    const event = Schema.decodeUnknownSync(JournaledEvent)({ _tag: "BackpackItemChanged", item: old });
    expect(event._tag === "BackpackItemChanged" && event.item.blockers).toEqual([]);
  });
});
