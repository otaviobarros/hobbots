import { describe, expect, it } from "vitest";
import { link, literal, printable, visible } from "./ansi.ts";

const ESC = "\u001b";

describe("what a command printed, written to the terminal", () => {
  it("keeps its colors and the erase a progress bar uses", () => {
    const text = `${ESC}[1;32mok${ESC}[0m\r${ESC}[K50%`;
    expect(printable(text)).toBe(text);
  });

  it("drops what would move the cursor, clear the screen, switch buffers or set a title", () => {
    expect(printable(`a${ESC}[2Jb${ESC}[3;4Hc${ESC}[?1049hd${ESC}]0;title\u0007e${ESC}7f`)).toBe("abcdef");
  });

  it("drops a link a command printed, so only the app's own links open", () => {
    expect(printable(link("https://example.com", "here"))).toBe("here");
  });

  it("drops control characters but keeps tabs, line ends and backspaces", () => {
    expect(printable("a\u0000b\u0007c\td\ne\rf\bg\u007f")).toBe("abc\td\ne\rf\bg");
  });

  it("drops an escape cut off at the end", () => {
    expect(printable(`done${ESC}[3`)).toBe("done");
    expect(printable(`done${ESC}]8;;http`)).toBe("done");
  });

  it("measures a line as it shows, without its escapes", () => {
    expect(visible(`${ESC}[32mok${ESC}[0m ${link("/log", "log")}`)).toBe("ok log");
  });
});

describe("text the app writes as typed", () => {
  it("shows each control character but tab as its picture, so none of them reaches the terminal", () => {
    expect(literal("a\u001b[2Jb\u0007c\rd\be\u007ff\tg")).toBe("a␛[2Jb␇c␍d␈e␡f\tg");
  });

  it("leaves text without controls as it is", () => {
    expect(literal("pnpm test -- --run ✓")).toBe("pnpm test -- --run ✓");
  });
});
