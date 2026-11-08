import { describe, expect, it } from "vitest";
import {
  CHORES_HEADING,
  choresInstructions,
  GOOD_AT_MAX,
  goodAtFromInstructions,
  goodAtPrefill,
  normalizeGoodAt,
  starterRole,
} from "../src/index.ts";

describe("good at", () => {
  it("is stored as one trimmed line, and as null when empty", () => {
    expect(normalizeGoodAt("  Sort\n the   inbox\t")).toBe("Sort the inbox");
    expect(normalizeGoodAt(" \n ")).toBeNull();
    expect(normalizeGoodAt(null)).toBeNull();
  });

  it("starts from the chores, else the starter role's note, else nothing", () => {
    expect(goodAtPrefill("Sort the inbox.\n\nPay the bills.", "assistant")).toBe("Sort the inbox. Pay the bills.");
    expect(goodAtPrefill("  ", "writer")).toBe(starterRole("writer").note);
    expect(goodAtPrefill("", null)).toBeNull();
  });

  it("shortens a prefill past the limit at the last word that fits, with an ellipsis", () => {
    const chores = "word ".repeat(60);
    const prefill = goodAtPrefill(chores, null) ?? "";
    expect(prefill.length).toBeLessThanOrEqual(GOOD_AT_MAX);
    expect(prefill).toBe(`${"word ".repeat(39)}word…`);
    // A single word longer than the limit is cut inside it.
    expect(goodAtPrefill("x".repeat(300), null)).toBe(`${"x".repeat(GOOD_AT_MAX - 1)}…`);
    // A line that fits exactly is kept whole.
    expect(goodAtPrefill("y".repeat(GOOD_AT_MAX), null)).toBe("y".repeat(GOOD_AT_MAX));
  });

  it("reads the chores folded into the instructions under their heading", () => {
    const instructions = choresInstructions("  Sort the inbox.\nPay the bills. ");
    expect(instructions).toBe(`${CHORES_HEADING}Sort the inbox.\nPay the bills.`);
    expect(goodAtFromInstructions({ instructions, role: "writer" })).toBe("Sort the inbox. Pay the bills.");
    expect(goodAtFromInstructions({ instructions: "Be brief.", role: "writer" })).toBe(starterRole("writer").note);
    expect(goodAtFromInstructions({ instructions: choresInstructions(" "), role: null })).toBeNull();
  });
});
