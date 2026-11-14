import { type Actor, type Mentionable, mentionsIn } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { markdownCode } from "../src/markdown-code.ts";

// Issue #1455 (ADR 039, Who answers): a mention written in Markdown code mentions nobody. What is
// code is decided by a CommonMark parser, so every case below reads as the spec reads it.

const PIP: Actor = { kind: "hob", id: "pip" };
const ROOK: Actor = { kind: "hob", id: "rook" };
const ANA: Actor = { kind: "user", id: "ana" };
const roster: ReadonlyArray<Mentionable> = [
  { actor: PIP, name: "Pip" },
  { actor: ROOK, name: "Rook" },
  { actor: ANA, name: "Ana" },
];

const mentioned = (text: string) => mentionsIn(text, roster, { skip: markdownCode(text) });

describe("mentions outside Markdown code", () => {
  it("skips code spans of any number of backticks, across lines", () => {
    expect(mentioned("Run `@Pip build` and ask @Ana")).toEqual([ANA]);
    expect(mentioned("``@Ana and ` @Rook`` then @Pip")).toEqual([PIP]);
    expect(mentioned("`spans\n@Rook two lines` and @Ana")).toEqual([ANA]);
    // A run nothing as long closes is plain text, so what follows it still mentions.
    expect(mentioned("a stray `` here\n@Rook please `x`")).toEqual([ROOK]);
    expect(mentioned("😀 `@Pip` @Rook")).toEqual([ROOK]);
  });

  it("skips fenced blocks, closed only by a fence of the same kind, as long, indented at most three spaces", () => {
    expect(mentioned("~~~\n@Rook\n~~~\n@Ana")).toEqual([ANA]);
    expect(mentioned("````md\n```\n@Rook\n```\n````\n@Pip")).toEqual([PIP]);
    expect(mentioned("   ```\n@Rook\n~~~\n@Ana")).toEqual([]);
    expect(mentioned("~~~\n    ~~~\n@Ana\n~~~\n@Rook")).toEqual([ROOK]);
    expect(mentioned("~~~\n- ~~~\n@Ana\n~~~\n@Rook")).toEqual([ROOK]);
    expect(mentioned("```\n> ```\n@Ana\n```\n@Rook")).toEqual([ROOK]);
  });

  it("skips fences in block quotes and list items at any depth, and indented code blocks", () => {
    expect(mentioned("> ~~~\n> @Ana\n> ~~~\n@Rook")).toEqual([ROOK]);
    expect(mentioned(">> ```\n>> @Ana\n>> ```\n> @Pip")).toEqual([PIP]);
    expect(mentioned("- item\n  - ```\n    @Ana\n    ```\n- @Pip")).toEqual([PIP]);
    // A fence in a quote ends where the quote does.
    expect(mentioned("> ```\n> @Ana\n\n@Rook")).toEqual([ROOK]);
    expect(mentioned("Before\n\n    @Ana in code\n\n@Rook")).toEqual([ROOK]);
    expect(mentioned("> @Ana said hi")).toEqual([ANA]);
  });
});
