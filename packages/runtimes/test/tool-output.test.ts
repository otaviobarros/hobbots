import { describe, expect, it } from "vitest";
import { toolOutputText } from "../src/tool-output.ts";

describe("toolOutputText", () => {
  it("reads a command's stdout, then its stderr", () => {
    expect(toolOutputText("Bash", { stdout: "built", stderr: "warning: slow", interrupted: false })).toBe(
      "built\nwarning: slow",
    );
    expect(toolOutputText("Bash", { stdout: "", stderr: "", interrupted: false })).toBeUndefined();
  });

  it("reads a search's matches, or the files it found", () => {
    expect(toolOutputText("Grep", { mode: "content", numFiles: 1, filenames: ["a.ts"], content: "a.ts:1:x" })).toBe(
      "a.ts:1:x",
    );
    expect(toolOutputText("Glob", { numFiles: 2, filenames: ["a.ts", "b.ts"], truncated: false })).toBe("a.ts\nb.ts");
  });

  it("reads a fetched page and a file read", () => {
    expect(toolOutputText("WebFetch", { result: "page", code: 200 })).toBe("page");
    expect(toolOutputText("Read", { type: "text", file: { filePath: "/a", content: "line" } })).toBe("line");
  });

  it("gives no output for a response with nothing to read, such as an edit's", () => {
    expect(toolOutputText("Edit", { filePath: "/a", oldString: "x", newString: "y" })).toBeUndefined();
    expect(toolOutputText("Bash", null)).toBeUndefined();
    expect(toolOutputText("Edit", "The file was updated.")).toBe("The file was updated.");
  });
});
