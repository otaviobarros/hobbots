import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fullToolOutput, toolOutputText } from "../src/tool-output.ts";

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

describe("fullToolOutput", () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-tool-output-")));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
  const config = join(temp, "runtime");
  const results = join(config, "projects", "p", "tool-results");
  mkdirSync(results, { recursive: true });
  const whole = `${"line\n".repeat(50_000)}error: the last line\n`;
  writeFileSync(join(results, "b1.txt"), whole);
  const outside = join(temp, "personal.txt");
  writeFileSync(outside, "Not for hobs.\n");
  symlinkSync(outside, join(results, "planted.txt"));

  // A command's output too large to return inline: an excerpt and the file with all of it.
  const persisted = (path: string) => ({
    stdout: "line\nline\n…",
    stderr: "",
    interrupted: false,
    persistedOutputPath: path,
    persistedOutputSize: whole.length,
  });

  it("reads the whole output Claude Code saved in its configuration folder", async () => {
    expect(await fullToolOutput("Bash", persisted(join(results, "b1.txt")), [config])).toBe(whole);
  });

  it("keeps the excerpt for a file outside the folder, a link or one that is gone", async () => {
    expect(await fullToolOutput("Bash", persisted(outside), [config])).toBe("line\nline\n…");
    expect(await fullToolOutput("Bash", persisted(join(results, "planted.txt")), [config])).toBe("line\nline\n…");
    expect(await fullToolOutput("Bash", persisted(join(results, "gone.txt")), [config])).toBe("line\nline\n…");
  });

  it("reads other tools' responses as they come", async () => {
    expect(await fullToolOutput("Grep", { content: "a.ts:1:x", filenames: [] }, [config])).toBe("a.ts:1:x");
  });
});
