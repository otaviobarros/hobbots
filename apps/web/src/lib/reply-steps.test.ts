import type { ReplyStep } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { operationLabel, shownSteps, stepOutcome } from "./reply-steps.ts";

const thinking: ReplyStep = { id: "thinking-1", kind: "thinking", label: "Thinking", state: "done" };
const edit: ReplyStep = {
  id: "t1",
  kind: "tool",
  label: "Editing cart.ts",
  state: "running",
  call: { tool: "Edit", operation: "edit-files", targets: ["/work/cart.ts"] },
};

describe("reply steps", () => {
  it("shows every step while the reply runs and only its tool calls once it ends", () => {
    expect(shownSteps([thinking, edit], true)).toEqual([thinking, edit]);
    expect(shownSteps([thinking, edit], false)).toEqual([edit]);
  });

  it("reads a step the reply ended before as unfinished, never as still running", () => {
    expect(stepOutcome(edit, true)).toBe("running");
    expect(stepOutcome(edit, false)).toBe("unfinished");
    expect(stepOutcome({ ...edit, state: "awaiting" }, false)).toBe("unfinished");
    expect(stepOutcome({ ...edit, state: "denied" }, false)).toBe("denied");
  });

  it("names an operation as the Permissions tab does", () => {
    expect(operationLabel("edit-files")).toBe("Create and edit files");
  });
});
