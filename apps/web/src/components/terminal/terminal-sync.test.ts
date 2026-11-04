import { describe, expect, it } from "vitest";
import { CLEAR_LINE } from "./ansi.ts";
import { terminalWrite } from "./terminal-sync.ts";

describe("moving a terminal to its next content", () => {
  it("writes nothing when nothing changed", () => {
    expect(terminalWrite("a\nb", "a\nb", 80)).toEqual({ kind: "none" });
  });

  it("writes only what was added", () => {
    expect(terminalWrite("", "a", 80)).toEqual({ kind: "append", data: "a" });
    expect(terminalWrite("a\nb", "a\nbc\nd", 80)).toEqual({ kind: "append", data: "c\nd" });
  });

  it("writes a changed last line in place, as a running command's clock", () => {
    expect(terminalWrite("$ sleep\n● Running · 3 sec", "$ sleep\n● Running · 4 sec", 80)).toEqual({
      kind: "append",
      data: `${CLEAR_LINE}● Running · 4 sec`,
    });
  });

  it("replaces the last line with the lines that follow it, as a command that ended", () => {
    expect(terminalWrite("$ ls\n● Running", "$ ls\na.md\n✓ took 1 sec", 80)).toEqual({
      kind: "append",
      data: `${CLEAR_LINE}a.md\n✓ took 1 sec`,
    });
  });

  it("starts again when an earlier line changed", () => {
    expect(terminalWrite("a\nb\nc", "a\nx\nc", 80)).toEqual({ kind: "reset", data: "a\nx\nc" });
  });

  it("starts again when the last line wrapped, which clearing one row would not remove", () => {
    expect(terminalWrite("a\n0123456789", "a\n01234", 10)).toEqual({ kind: "reset", data: "a\n01234" });
  });
});
