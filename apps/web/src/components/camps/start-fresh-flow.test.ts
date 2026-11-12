import { ThreadId } from "@hobbots/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import {
  ASKING,
  canRetry,
  type StartFreshError,
  type StartFreshEvent,
  startFreshError,
  startFreshStep,
} from "./start-fresh-flow.ts";

const K1 = ThreadId.make("k1");
const K2 = ThreadId.make("k2");

describe("Start fresh", () => {
  it("starts under a new key, and tries again under the same one", () => {
    const starting = startFreshStep(ASKING, { _tag: "Start", key: K1 });
    expect(starting).toEqual({ step: "starting", key: K1 });
    // A second press while it starts changes nothing.
    expect(startFreshStep(starting, { _tag: "Start", key: K2 })).toBe(starting);
    const failed = startFreshStep(starting, { _tag: "Failed", error: "unreachable" });
    expect(failed).toEqual({ step: "failed", key: K1, error: "unreachable" });
    expect(startFreshStep(failed, { _tag: "Start", key: K2 })).toEqual({ step: "starting", key: K1 });
  });

  it("names the hub's refusal, and offers a try again only where it can help", () => {
    const refused = (reason: string) => startFreshError(new ApiError("", "StartFreshRefused", { reason }));
    expect(refused("reply-running")).toBe("reply-running");
    expect(refused("approval-pending")).toBe("approval-pending");
    expect(refused("not-open-chat")).toBe("not-open-chat");
    expect(refused("something-new")).toBe("unreachable");
    expect(startFreshError(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(canRetry("reply-running")).toBe(true);
    expect(canRetry("unreachable")).toBe(true);
    expect(canRetry("not-open-chat")).toBe(false);
    expect(canRetry("hob-retired")).toBe(false);
  });

  // A model of the flow: any run of events agrees with it step by step.
  it("agrees with its model for any run of events", () => {
    const errors: ReadonlyArray<StartFreshError> = ["reply-running", "approval-pending", "unreachable"];
    const anyEvent: fc.Arbitrary<StartFreshEvent> = fc.oneof(
      fc.integer({ min: 1, max: 99 }).map((n) => ({ _tag: "Start" as const, key: ThreadId.make(`k${n}`) })),
      fc.constantFrom(...errors).map((error) => ({ _tag: "Failed" as const, error })),
    );
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 30 }), (events) => {
        let state = ASKING;
        let key: ThreadId | null = null;
        for (const event of events) {
          const before = state.step;
          state = startFreshStep(state, event);
          if (event._tag === "Start" && before !== "starting") key ??= event.key;
          const expected = event._tag === "Start" ? "starting" : before === "starting" ? "failed" : before;
          expect(state.step).toBe(expected);
          // One request, one key: every try after the first sends the key the first one sent.
          if (state.step !== "asking") expect(state.key).toBe(key);
        }
      }),
    );
  });
});
