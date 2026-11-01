import type { ReplyStep } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { formatBytes, operationLabel, shownSteps } from "./reply-steps.ts";

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

  it("names an operation as the Permissions tab does", () => {
    expect(operationLabel("edit-files")).toBe("Create and edit files");
  });

  it("names a size in the largest unit that keeps it at 1 or more", () => {
    expect(formatBytes(512, "en-US")).toBe("512 byte");
    expect(formatBytes(16 * 1024, "en-US")).toBe("16 kB");
    expect(formatBytes(3.45 * 1024 * 1024, "en-US")).toBe("3.5 MB");
  });
});
