import { describe, expect, it } from "vitest";
import { memorySearchTerms, memoryTermsFound, memoryWordsOf } from "../src/memory-search.ts";

describe("memory search terms", () => {
  it("leaves the common words of a question out", () => {
    expect(memorySearchTerms("How does this project run its tests?")).toEqual(["project", "run", "tests"]);
  });

  it("keeps a hyphenated or snake-case name whole, folded", () => {
    expect(memorySearchTerms("Run `make Tide-Check` and tide_lint")).toEqual([
      "run",
      "make",
      "tide-check",
      "tide_lint",
    ]);
  });

  it("keeps the common words when they are all the query holds", () => {
    expect(memorySearchTerms("how to")).toEqual(["how", "to"]);
    expect(memorySearchTerms("  -- ")).toEqual([]);
  });

  it("counts the terms a page holds as words or their starts", () => {
    const words = memoryWordsOf("This project runs its tests with `make tide-check`.");
    expect(memoryTermsFound(words, ["run", "tes", "tide"])).toBe(3);
    expect(memoryTermsFound(words, ["check", "lint"])).toBe(0);
  });
});
