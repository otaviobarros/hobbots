import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Actor, type Mentionable, mentions, mentionsIn } from "../src/index.ts";

// Issue #1455 (ADR 039, Who answers): a message's @mentions are parsed once into ordered actors,
// hobs and people, each once.

const PIP: Actor = { kind: "hob", id: "pip" };
const PIP_TWO: Actor = { kind: "hob", id: "pip-two" };
const ROOK: Actor = { kind: "hob", id: "rook" };
const ANA: Actor = { kind: "user", id: "ana" };

const roster: ReadonlyArray<Mentionable> = [
  { actor: PIP, name: "Pip" },
  { actor: PIP_TWO, name: "Pip Two" },
  { actor: ROOK, name: "Rook" },
  { actor: ANA, name: "Ana" },
];

describe("mentionsIn", () => {
  it("finds hobs and people in the order first mentioned, each once", () => {
    expect(mentionsIn("@Rook can you and @ana check, then @rook again and @Pip?", roster)).toEqual([ROOK, ANA, PIP]);
  });

  it("prefers the longer of two names that both fit", () => {
    expect(mentionsIn("@Pip Two and @Pip", roster)).toEqual([PIP_TWO, PIP]);
  });

  it("needs the name to stand whole after the @, followed by punctuation or the end", () => {
    expect(mentionsIn("@Pipe @Rooky @Pip, @Rook.", roster)).toEqual([PIP, ROOK]);
    expect(mentionsIn("Thanks @Ana", roster)).toEqual([ANA]);
  });

  it("reads an @ inside a word, such as an email address, as text", () => {
    expect(mentionsIn("write to ana@pip.dev or rook@ROOK", roster)).toEqual([]);
  });

  it("never finds a mention in Markdown code", () => {
    const text = "Run `@Pip build` and\n```\n@Rook deploy\n```\nthen ask @Ana";
    expect(mentionsIn(text, roster)).toEqual([ANA]);
  });

  it("reads code spans as CommonMark does: any run of backticks, closed by a run as long, across lines", () => {
    expect(mentionsIn("``@Ana and ` @Rook`` then @Pip", roster)).toEqual([PIP]);
    expect(mentionsIn("`spans\n@Rook two lines` and @Ana", roster)).toEqual([ANA]);
    // A run nothing as long closes is plain text, so what follows it still mentions.
    expect(mentionsIn("a stray `` here\n@Rook please `x`", roster)).toEqual([ROOK]);
    expect(mentionsIn("😀 `@Pip` @Rook", roster)).toEqual([ROOK]);
  });

  it("reads fenced blocks of ``` or ~~~, closed only by a fence as long of the same kind", () => {
    expect(mentionsIn("~~~\n@Rook\n~~~\n@Ana", roster)).toEqual([ANA]);
    expect(mentionsIn("````md\n```\n@Rook\n```\n````\n@Pip", roster)).toEqual([PIP]);
    expect(mentionsIn("   ```\n@Rook\n~~~\n@Ana", roster)).toEqual([]);
    // A line of backticks is read as a fence at any indentation: at worst a mention is missed, never invented.
    expect(mentionsIn("    ```\n@Rook", roster)).toEqual([]);
  });

  it("reads fences inside block quotes and list items, at any depth", () => {
    expect(mentionsIn("> ~~~\n> @Ana\n> ~~~\n@Rook", roster)).toEqual([ROOK]);
    expect(mentionsIn(">> ```\n>> @Ana\n>> ```\n> @Pip", roster)).toEqual([PIP]);
    expect(mentionsIn("- ```\n  @Ana\n  ```\n1. @Rook", roster)).toEqual([ROOK]);
    expect(mentionsIn("- item\n  - ```\n    @Ana\n    ```\n- @Pip", roster)).toEqual([PIP]);
    // Inside a fence, what looks like a list item or a quote is code, and closes nothing.
    expect(mentionsIn("~~~\n- ~~~\n@Ana\n~~~\n@Rook", roster)).toEqual([ROOK]);
    expect(mentionsIn("```\n> ```\n@Ana\n```\n@Rook", roster)).toEqual([ROOK]);
    // A fence in a quote ends where the quote does.
    expect(mentionsIn("> ```\n> @Ana\n@Rook", roster)).toEqual([ROOK]);
    // A quote marker alone is no fence: what it quotes still mentions.
    expect(mentionsIn("> @Ana said hi", roster)).toEqual([ANA]);
  });

  it("reads only the mentions that end past `after`, for text that grew after its start was parsed", () => {
    const kept = "Asking @Rook";
    // Rook was renamed since: the start is not read again, so a new hob called Rook is not added.
    const renamed: ReadonlyArray<Mentionable> = [{ actor: PIP, name: "Rook" }, ...roster.slice(3)];
    expect(mentionsIn(`${kept}, then @Ana`, renamed, kept.length)).toEqual([ANA]);
    // A mention cut in two by the end of what was parsed counts as new.
    expect(mentionsIn("Asking @Ro" + "ok", roster, "Asking @Ro".length)).toEqual([ROOK]);
    // What decides code reads the whole text: a fence opened before `after` still hides what follows.
    expect(mentionsIn("```\nhi" + "\n@Rook", roster, "```\nhi".length)).toEqual([]);
  });

  it("finds no one with no @, an unknown name or a blank roster name", () => {
    expect(mentionsIn("Pip and Rook", roster)).toEqual([]);
    expect(mentionsIn("@Quill there?", roster)).toEqual([]);
    expect(mentionsIn("@ hello", [{ actor: PIP, name: "  " }])).toEqual([]);
  });

  it("cuts each name at its own length when folding case changes a string's length", () => {
    const istanbul: Actor = { kind: "user", id: "istanbul" };
    expect(mentionsIn("@İz said hi", [{ actor: istanbul, name: "İz" }])).toEqual([istanbul]);
  });

  it("returns each mentioned actor once, in the order of its first mention", () => {
    const names = fc.constantFrom(...roster);
    fc.assert(
      fc.property(fc.array(names, { maxLength: 12 }), (picked) => {
        const text = picked.map((entry) => `@${entry.name}`).join(" and ");
        const expected: Array<Actor> = [];
        for (const { actor } of picked) if (!expected.includes(actor)) expected.push(actor);
        expect(mentionsIn(text, roster)).toEqual(expected);
      }),
    );
  });
});

describe("mentions", () => {
  it("says whether a message mentions the actor", () => {
    expect(mentions({ mentions: [ROOK, ANA] }, { kind: "user", id: "ana" })).toBe(true);
    expect(mentions({ mentions: [ROOK] }, ANA)).toBe(false);
  });
});
