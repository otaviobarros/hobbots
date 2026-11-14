import { describe, expect, it } from "vitest";
import { messages } from "./messages.ts";

// ADR 039 (Who answers): the hub refuses a mention of a hob that is not in the thread with the
// hobs' ids; the composer says it in words.
describe("the words for a refused mention", () => {
  it("names who is not in the camp and offers to add them", () => {
    const say = messages.composer.mentionRefused;
    expect(say({ names: ["Rook"], kind: "camp" })).toBe("Rook isn't in this camp. Add Rook?");
    expect(say({ names: ["Rook", "Pip"], kind: "camp" })).toBe("Rook and Pip aren't in this camp. Add them?");
    expect(say({ names: ["Rook", "Pip", "Leo"], kind: "camp" })).toBe(
      "Rook, Pip, and Leo aren't in this camp. Add them?",
    );
    expect(say({ names: ["Rook"], kind: "chat" })).toBe("Rook isn't in this direct message.");
  });
});
