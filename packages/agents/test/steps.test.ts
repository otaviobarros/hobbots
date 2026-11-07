import type { ReplyStep } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { nextSteps, stoppedCommands, uncertainCalls } from "../src/steps.ts";

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
    const output = { head: "boom\n", tail: "", omittedBytes: 0, totalBytes: 5, logged: false };
    const failed = nextSteps(running ?? [], 0, { _tag: "ToolFinished", id: "t1", failed: true }, undefined, output);
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

describe("a reply that waits on commands (#1056)", () => {
  const dev = { _tag: "ToolStarted", id: "t2", ...call, label: "Running pnpm dev" } as const;
  const both = () => {
    const one = nextSteps([], 0, started, "2026-11-07T10:00:00.000Z") ?? [];
    return nextSteps(one, 0, dev, "2026-11-07T10:01:00.000Z") ?? [];
  };
  const waited = (steps: ReadonlyArray<ReplyStep> | null) =>
    steps?.filter((step) => step.waitedOn === true).map((step) => step.id);

  it("marks only the running commands the turn waits on, and only once", () => {
    const steps = both();
    const waiting = nextSteps(steps, 0, { _tag: "AwaitingCommands", ids: ["t2"] });
    expect(waited(waiting)).toEqual(["t2"]);
    expect(nextSteps(waiting ?? [], 0, { _tag: "AwaitingCommands", ids: ["t2"] })).toBeNull();
    // A call that is not a running command is never waited on.
    expect(nextSteps(waiting ?? [], 0, { _tag: "AwaitingCommands", ids: ["nothing"] })?.some((s) => s.waitedOn)).toBe(
      false,
    );
  });

  it("stops waiting once a waited command ends, since its end starts a follow-up", () => {
    const waiting = nextSteps(both(), 0, { _tag: "AwaitingCommands", ids: ["t1", "t2"] }) ?? [];
    const ended = nextSteps(waiting, 0, { _tag: "ToolFinished", id: "t2", failed: false });
    expect(states(ended)).toEqual(["t1:running", "t2:done"]);
    expect(waited(ended)).toEqual([]);
  });

  it("cuts a waited command off when you stop waiting, with when", () => {
    const waiting = nextSteps(both(), 0, { _tag: "AwaitingCommands", ids: ["t2"] }) ?? [];
    const stopped = nextSteps(waiting, 0, { _tag: "ToolStopped", id: "t2" }, "2026-11-07T10:15:00.000Z");
    expect(states(stopped)).toEqual(["t1:running", "t2:stopped"]);
    expect(stopped?.[1]).toMatchObject({ endedAt: "2026-11-07T10:15:00.000Z" });
    expect(stopped?.[1]?.waitedOn).toBeUndefined();
    expect(nextSteps(stopped ?? [], 0, { _tag: "ToolStopped", id: "t2" })).toBeNull();
  });

  it("tells the next turn which commands you stopped", () => {
    const stopped = nextSteps(nextSteps(both(), 0, { _tag: "AwaitingCommands", ids: ["t2"] }) ?? [], 0, {
      _tag: "ToolStopped",
      id: "t2",
    });
    const told = stoppedCommands(stopped ?? []) ?? "";
    expect(told).toContain("the user stopped these commands");
    expect(told.split("\n").filter((line) => line.startsWith("- "))).toEqual(["- Running pnpm dev"]);
    expect(stoppedCommands(both())).toBeNull();
  });
});
