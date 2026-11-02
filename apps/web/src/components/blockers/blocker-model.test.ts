import {
  AgentId,
  BackpackBlocker,
  BackpackDelivery,
  BackpackItem,
  BackpackItemId,
  type BackpackPayload,
  TaskId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { withBlocker } from "../../api/blockers.ts";
import { blockersOn, blockerWhat, blockerWhy } from "./blocker-model.ts";

const at = "2026-11-02T00:00:00.000Z";

const blocker = (number: number, afterDeliveries: number, decision: "retry" | null, retired = false) =>
  new BackpackBlocker({
    number,
    reason: retired ? "recipient-retired" : "retries-exhausted",
    nextAction: retired ? "dismiss" : "retry",
    diagnostic: "The runtime stopped.",
    lastEnd: retired ? null : "failed",
    afterDeliveries,
    raisedAt: at,
    decision,
    decidedAt: decision === null ? null : at,
  });

const item = (
  id: string,
  options: {
    readonly state?: BackpackItem["state"];
    readonly blockers?: ReadonlyArray<BackpackBlocker>;
    readonly taskId?: string | null;
    readonly revision?: number;
    readonly payload?: BackpackPayload;
  } = {},
) =>
  new BackpackItem({
    id: BackpackItemId.make(id),
    recipientId: AgentId.make("aldric"),
    kind: options.payload?._tag ?? "message",
    actionable: true,
    priority: 1,
    state: options.state ?? "failed",
    taskId:
      options.taskId === undefined ? TaskId.make("t1") : options.taskId === null ? null : TaskId.make(options.taskId),
    questId: null,
    attemptId: null,
    threadId: null,
    dedupeKey: id,
    payload: options.payload ?? { _tag: "message", senderId: null, text: "Hi" },
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [1, 2, 3, 4, 5, 6].map(
      (number) =>
        new BackpackDelivery({
          number,
          target: "thread:t1",
          turnId: `turn-${number}`,
          deliveredAt: at,
          acknowledgedSessionId: null,
          acknowledgedAt: null,
        }),
    ),
    blockers: options.blockers ?? [blocker(1, 3, null)],
    disposition: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    revision: options.revision ?? 1,
  });

describe("blockers", () => {
  it("says what stuck work was and why, counting only the tries since the last retry", () => {
    const again = item("a", { blockers: [blocker(1, 3, "retry"), blocker(2, 6, null)] });
    expect(blockerWhat(again)).toBe("Reading a message");
    expect(blockerWhy(again, again.blockers[1] as BackpackBlocker, "Aldric")).toBe(
      "It was tried 3 times, and every turn ended early. The last try failed.",
    );
    const retired = item("b", { blockers: [blocker(1, 0, null, true)] });
    expect(blockerWhy(retired, retired.blockers[0] as BackpackBlocker, "Quill")).toBe(
      "Quill retired, so nobody can take it.",
    );
  });

  it("puts on a Task card only the open blockers about its Tasks", () => {
    const items = [item("on"), item("elsewhere", { taskId: "t9" }), item("none", { taskId: null })];
    expect(blockersOn(items, new Set(["t1"])).map((each) => each.id)).toEqual(["on"]);
  });

  it("keeps a blocker listed while it waits for a choice, at its newest version, and drops it once decided", () => {
    const listed = [item("a")];
    expect(withBlocker(listed, item("a", { revision: 0 }))).toBe(listed);
    expect(withBlocker(listed, item("b", { revision: 2 }))?.map((each) => each.id)).toEqual(["a", "b"]);
    expect(
      withBlocker(listed, item("a", { state: "pending", blockers: [blocker(1, 3, "retry")], revision: 2 })),
    ).toEqual([]);
    expect(withBlocker(undefined, item("a"))).toBeUndefined();
  });
});
