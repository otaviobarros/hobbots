import { describe, expect, it } from "vitest";
import { CHIEF, CHIEF_FLAME, CHIEF_PALETTE, chiefFrame } from "./chief.ts";

const changedCells = (rows: ReadonlyArray<string>) =>
  rows.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === CHIEF[y]?.[x] ? [] : [`${x},${y}:${cell}`])));

describe("chiefFrame", () => {
  it("draws every frame on the same 20 × 20 grid in the chief's palette", () => {
    for (const gaze of ["ahead", "left", "right", "blink"] as const) {
      const rows = chiefFrame(gaze);
      expect(rows).toHaveLength(20);
      for (const row of rows) {
        expect(row).toHaveLength(20);
        for (const cell of row) expect(cell === "." || cell in CHIEF_PALETTE).toBe(true);
      }
    }
  });

  it("moves only the eyes, one cell to the side", () => {
    expect(chiefFrame("ahead")).toBe(CHIEF);
    expect(changedCells(chiefFrame("left")).sort()).toEqual(
      ["3,6:k", "3,7:k", "4,6:s", "4,7:s", "10,6:k", "10,7:k", "11,6:s", "11,7:s"].sort(),
    );
    expect(changedCells(chiefFrame("right")).sort()).toEqual(
      ["5,6:k", "5,7:k", "4,6:s", "4,7:s", "12,6:k", "12,7:k", "11,6:s", "11,7:s"].sort(),
    );
  });

  it("closes the eyes to a line for a blink", () => {
    expect(changedCells(chiefFrame("blink")).sort()).toEqual(["4,6:s", "11,6:s"].sort());
  });

  it("keeps only the lantern light in the flame overlay", () => {
    const lit = CHIEF_FLAME.join("").replace(/\./g, "");
    expect(lit).toBe("LLLL");
  });
});
