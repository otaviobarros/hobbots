import { describe, expect, it } from "vitest";
import { choiceFor, reducesMotion } from "./motion.ts";

describe("Reduce motion", () => {
  it("follows the system until this device chooses", () => {
    expect(reducesMotion("system", true)).toBe(true);
    expect(reducesMotion("system", false)).toBe(false);
    expect(reducesMotion("reduce", false)).toBe(true);
    expect(reducesMotion("full", true)).toBe(false);
  });

  it("goes back to following the system when the switch matches it", () => {
    expect(choiceFor(true, true)).toBe("system");
    expect(choiceFor(false, false)).toBe("system");
    expect(choiceFor(true, false)).toBe("reduce");
    expect(choiceFor(false, true)).toBe("full");
  });
});
