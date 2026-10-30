import { describe, expect, it } from "vitest";
import { searchTerms, snippetOf } from "../src/index.ts";

const text = (parts: ReadonlyArray<{ text: string; match: boolean }>) =>
  parts.map((part) => (part.match ? `[${part.text}]` : part.text)).join("");

describe("searchTerms", () => {
  it("folds case and accents, drops punctuation and repeats", () => {
    expect(searchTerms("  Café, CAFE! résumé-2026 ")).toEqual(["cafe", "resume", "2026"]);
    expect(searchTerms("¿?")).toEqual([]);
  });

  it("keeps at most eight words", () => {
    expect(searchTerms("a b c d e f g h i j")).toHaveLength(8);
  });
});

describe("snippetOf", () => {
  it("marks every word that starts with a term", () => {
    expect(text(snippetOf("Plant tomatoes; the Tomato plant.", ["tomat", "plant"]))).toBe(
      "[Plant] [tomatoes]; the [Tomato] [plant].",
    );
  });

  it("keeps the first match in view and cuts long text at spaces", () => {
    const long = `${"early words ".repeat(20)}the needle sits here ${"later words ".repeat(20)}`;
    expect(text(snippetOf(long, ["needle"], 60))).toBe("…early words the [needle] sits here later words later words…");
  });

  it("collapses whitespace and matches accented words", () => {
    expect(text(snippetOf("Un\n\ncafé   noir", ["cafe"]))).toBe("Un [café] noir");
  });
});
