import type { Message, ReplyStep } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { nextSteps, stepsSinceCompleted, uncertainCalls } from "../src/steps.ts";

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
    const running = nextSteps(awaiting ?? [], 0, started, "2026-11-01T01:00:00.000Z");
    expect(states(running)).toEqual(["t1:running"]);
    expect(running?.[0]?.startedAt).toBe("2026-11-01T01:00:00.000Z");
    const failed = nextSteps(running ?? [], 0, { _tag: "ToolFinished", id: "t1", failed: true });
    expect(states(failed)).toEqual(["t1:failed"]);
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

describe("uncertainCalls", () => {
  it("names each tool call left uncertain, with what it acted on, and nothing else", () => {
    const steps: ReadonlyArray<ReplyStep> = [
      { id: "k1", kind: "thinking", label: "Thinking", state: "unfinished" },
      { id: "t1", kind: "tool", label: "Running pnpm test", state: "done", call },
      {
        id: "t2",
        kind: "tool",
        label: "Running git push",
        state: "uncertain",
        call: { ...call, operation: "push", targets: ["origin"] },
      },
      { id: "t3", kind: "tool", label: "Listing files", state: "uncertain", call: { ...call, targets: [] } },
    ];
    const told = uncertainCalls(steps) ?? "";
    expect(told.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- Running git push (Bash, push on origin)",
      "- Listing files (Bash, run-commands)",
    ]);
    expect(told).toContain("Do not run any of them again");
    expect(uncertainCalls(steps.slice(0, 2))).toBeNull();
  });
});

describe("stepsSinceCompleted", () => {
  it("keeps the steps of the replies after the thread's last completed reply", () => {
    const reply = (status: Message["status"], id: string): Message =>
      ({
        role: "assistant",
        status,
        steps: [{ id, kind: "tool", label: id, state: "uncertain", call }],
      }) as unknown as Message;
    const prompt = { role: "user", status: "complete", steps: [] } as unknown as Message;
    const steps = (transcript: ReadonlyArray<Message>) => stepsSinceCompleted(transcript).map((step) => step.id);
    expect(steps([reply("interrupted", "a"), prompt, reply("stopped", "b"), prompt])).toEqual(["a", "b"]);
    expect(steps([reply("interrupted", "a"), prompt, reply("complete", "c"), prompt])).toEqual([]);
    expect(steps([])).toEqual([]);
  });
});
