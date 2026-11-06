import { describe, expect, it } from "vitest";
import { memorySearchTerms, memoryTermsFound, memoryWordsOf } from "../src/memory-search.ts";

const words = (query: string) => memorySearchTerms(query).map((term) => term.word);

describe("memory search terms", () => {
  it("keeps every word of a question in any language, folded and without repeats", () => {
    expect(words("How does this project run its tests?")).toEqual([
      "how",
      "does",
      "this",
      "project",
      "run",
      "its",
      "tests",
    ]);
    expect(words("Como este projeto roda os testes? Não sei, não.")).toEqual([
      "como",
      "este",
      "projeto",
      "roda",
      "os",
      "testes",
      "nao",
      "sei",
    ]);
  });

  it("keeps a hyphenated or snake-case name whole", () => {
    expect(words("Run `make Tide-Check` and tide_lint")).toEqual(["run", "make", "tide-check", "and", "tide_lint"]);
    expect(words("  -- ")).toEqual([]);
  });

  it("matches a word of three letters or more as a start, and a shorter one only whole", () => {
    expect(memorySearchTerms("os testes")).toEqual([
      { word: "os", prefix: false },
      { word: "testes", prefix: true },
    ]);
    const page = memoryWordsOf("Este projeto roda os testes com `make tide-check`.");
    expect(memoryTermsFound(page, memorySearchTerms("rod tes tide"))).toBe(3);
    expect(memoryTermsFound(page, memorySearchTerms("o check lint"))).toBe(0);
    expect(memoryTermsFound(page, memorySearchTerms("os"))).toBe(1);
  });
});
