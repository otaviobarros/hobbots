import { describe, expect, it } from "vitest";
import { editPlain, joinEscapes, splitEscapes, stripEscapes } from "../src/index.ts";

const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";
const LINK = "\u001b]8;;https://example.com\u0007";
const LINK_END = "\u001b]8;;\u001b\\";

describe("stripEscapes", () => {
  it("takes out colors, cursor moves, links and short escapes and leaves the text", () => {
    expect(stripEscapes(`${GREEN}+ added${RESET}\n\u001b[1;31merror\u001b[m\n\u001b[2K\u001b7done`)).toBe(
      "+ added\nerror\ndone",
    );
    expect(stripEscapes(`see ${LINK}the docs${LINK_END}.`)).toBe("see the docs.");
    expect(stripEscapes("\u009b31mred")).toBe("red");
  });

  it("takes out a sequence cut off at the end", () => {
    expect(stripEscapes("done\u001b[3")).toBe("done");
    expect(stripEscapes("done\u001b")).toBe("done");
  });

  it("leaves text without escapes as it is", () => {
    const text = "plain [32m text\twith tabs\r\n";
    expect(stripEscapes(text)).toBe(text);
  });
});

describe("splitEscapes", () => {
  it("takes text apart and puts it back as it was", () => {
    const text = `${GREEN}diff${RESET} --git ${LINK}a${LINK_END}`;
    const split = splitEscapes(text);
    expect(split.plain).toBe("diff --git a");
    expect(split.escapes.map((sequence) => sequence.at)).toEqual([0, 4, 11, 12]);
    expect(joinEscapes(split)).toBe(text);
  });
});

describe("editPlain", () => {
  it("keeps escapes before, inside and after an edit in order", () => {
    // "ab" green "cd" reset "ef": "bcd" is replaced by "X".
    const split = splitEscapes(`ab${GREEN}cd${RESET}ef`);
    const edited = editPlain(split, [{ start: 1, end: 4, text: "X" }]);
    expect(joinEscapes(edited)).toBe(`aX${GREEN}${RESET}ef`);
  });

  it("keeps an sequence at an edit's start before it and one at its end after it", () => {
    const split = splitEscapes(`${GREEN}secret${RESET} and ${GREEN}secret${RESET}`);
    const edited = editPlain(split, [
      { start: 0, end: 6, text: "[a]" },
      { start: 11, end: 17, text: "[b]" },
    ]);
    expect(joinEscapes(edited)).toBe(`${GREEN}[a]${RESET} and ${GREEN}[b]${RESET}`);
  });
});
