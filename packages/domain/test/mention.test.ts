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

  it("skips the ranges it is given, such as Markdown code a parser found", () => {
    const text = "Run `@Pip build`, then ask @Ana";
    const code = { from: text.indexOf("`"), to: text.lastIndexOf("`") + 1 };
    expect(mentionsIn(text, roster, { skip: [code] })).toEqual([ANA]);
    // Ranges in any order, overlapping or not, skip what any of them covers.
    const all = { from: 0, to: text.length };
    expect(mentionsIn(text, roster, { skip: [all, code] })).toEqual([]);
    expect(
      mentionsIn("@Rook @Pip @Ana", roster, {
        skip: [
          { from: 11, to: 15 },
          { from: 0, to: 5 },
        ],
      }),
    ).toEqual([PIP]);
  });

  it("reads only the mentions that end past `after`, for text that grew after its start was parsed", () => {
    const kept = "Asking @Rook";
    // Rook was renamed since: the start is not read again, so a new hob called Rook is not added.
    const renamed: ReadonlyArray<Mentionable> = [{ actor: PIP, name: "Rook" }, ...roster.slice(3)];
    expect(mentionsIn(`${kept}, then @Ana`, renamed, { after: kept.length })).toEqual([ANA]);
    // A mention cut in two by the end of what was parsed counts as new.
    expect(mentionsIn("Asking @Ro" + "ok", roster, { after: "Asking @Ro".length })).toEqual([ROOK]);
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
