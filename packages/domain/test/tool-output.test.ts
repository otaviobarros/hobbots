import { describe, expect, it } from "vitest";
import { previewToolOutput } from "../src/index.ts";

describe("previewToolOutput", () => {
  it("keeps output that fits whole", () => {
    expect(previewToolOutput("ok\n", 4)).toEqual({ head: "ok\n", tail: "", omittedBytes: 0, totalBytes: 3 });
    expect(previewToolOutput("12345678", 4)).toEqual({ head: "12345678", tail: "", omittedBytes: 0, totalBytes: 8 });
  });

  it("keeps the start and the end of long output and counts what it left out", () => {
    expect(previewToolOutput("setup-middle-error", 5)).toEqual({
      head: "setup",
      tail: "error",
      omittedBytes: 8,
      totalBytes: 18,
    });
  });

  it("cuts between characters, never inside one", () => {
    // Each é is two bytes; a cut at byte 3 would split the second one.
    const preview = previewToolOutput("éééxxxxxxxééé", 3);
    expect(preview.head).toBe("é");
    expect(preview.tail).toBe("é");
    expect(new TextEncoder().encode(preview.head).length + preview.omittedBytes + 2).toBe(preview.totalBytes);
  });

  it("cuts at a line break when the part has one", () => {
    expect(previewToolOutput("one\ntwo\nmiddle\nend\nlast", 9)).toEqual({
      head: "one\ntwo\n",
      tail: "end\nlast",
      omittedBytes: 7,
      totalBytes: 23,
    });
  });
});
