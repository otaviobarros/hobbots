import type { ReplyStep } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { nextSteps } from "../src/steps.ts";

const call = { tool: "Bash", operation: "run-commands", targets: ["/work"] } as const;
const started = { _tag: "ToolStarted", id: "t1", ...call, label: "Running pnpm test" } as const;
const states = (steps: ReadonlyArray<ReplyStep> | null) => steps?.map((step) => `${step.id}:${step.state}`);

describe("nextSteps", () => {
  // covers CH-004, PE-002
  it("[TC-CH-112] follows a tool call from Ask through its start to its outcome, and leaves ended steps alone", () => {
    const awaiting = nextSteps([], 0, {
      _tag: "ToolAwaitingApproval",
      id: "t1",
      approvalId: "a1",
      ...call,
      label: "Running pnpm test",
    });
    expect(awaiting).toEqual([
      { id: "t1", kind: "tool", label: "Running pnpm test", state: "awaiting", call, approvalId: "a1" },
    ]);
    const running = nextSteps(awaiting ?? [], 0, started);
    expect(states(running)).toEqual(["t1:running"]);
    const output = { head: "boom\n", tail: "", omittedBytes: 0, totalBytes: 5, logged: false };
    const failed = nextSteps(running ?? [], 0, { _tag: "ToolFinished", id: "t1", failed: true }, output);
    expect(states(failed)).toEqual(["t1:failed"]);
    expect(failed?.[0]?.output).toEqual(output);
    // A late or repeated end changes nothing, and text is not a step.
    expect(nextSteps(failed ?? [], 0, { _tag: "ToolFinished", id: "t1", failed: false })).toBeNull();
    expect(nextSteps(failed ?? [], 0, { _tag: "TextDelta", text: "hi" })).toBeNull();
  });

  it("records a refused call with its reason and who refused it", () => {
    const denied = nextSteps([], 0, {
      _tag: "ToolDenied",
      id: "t2",
      ...call,
      label: "Running rm -rf /",
      reason: "Outside its folders",
      decidedBy: "sandbox",
    });
    expect(denied).toEqual([
      {
        id: "t2",
        kind: "tool",
        label: "Running rm -rf /",
        state: "denied",
        call,
        reason: "Outside its folders",
        decidedBy: "sandbox",
      },
    ]);
  });

  it("keeps the steps of earlier turns, so an id used again after Continue starts a new step with its own id", () => {
    const earlier: ReadonlyArray<ReplyStep> = [
      { id: "thinking-1", kind: "thinking", label: "Thinking", state: "done" },
    ];
    const again = nextSteps(earlier, 1, { _tag: "StepStarted", id: "thinking-1", kind: "thinking", label: "Thinking" });
    expect(states(again)).toEqual(["thinking-1:done", "thinking-1@1:running"]);
    expect(states(nextSteps(again ?? [], 1, { _tag: "StepEnded", id: "thinking-1" }))).toEqual([
      "thinking-1:done",
      "thinking-1@1:done",
    ]);
  });
});
