import { describe, expect, it } from "vitest";
import { exactAction } from "../src/approval.ts";

describe("exactAction", () => {
  it("shows the command, path or address the call was made with", () => {
    expect(exactAction({ arguments: { command: "git push origin main", description: "Push" }, label: "Push" })).toBe(
      "git push origin main",
    );
    expect(exactAction({ arguments: { file_path: "/w/a.md", content: "long" }, label: "Write" })).toBe("/w/a.md");
  });

  it("falls back to the step's words when no argument says it", () => {
    expect(exactAction({ arguments: { level: 3 }, label: "Running git push origin main" })).toBe(
      "Running git push origin main",
    );
    expect(exactAction({ arguments: { command: "  " }, label: "Running" })).toBe("Running");
  });
});
