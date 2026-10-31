import { describe, expect, it } from "vitest";
import { PLATFORMS } from "../src/data/copy.ts";
import { HERO_STARS, HOUSES, osIcon, ROLL_STARS } from "../src/data/scene.ts";

describe("the night village", () => {
  it("keeps every star inside the sky", () => {
    for (const star of [...HERO_STARS, ...ROLL_STARS]) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThan(100);
    }
  });

  it("shows one house on narrow screens", () => {
    expect(HOUSES.filter((house) => !house.wide)).toHaveLength(1);
  });

  it("draws every platform icon on a 12 × 12 grid with a color for each pixel", () => {
    for (const platform of PLATFORMS) {
      const { rows, palette } = osIcon(platform.icon);
      expect(rows).toHaveLength(12);
      for (const row of rows) {
        expect(row).toHaveLength(12);
        for (const cell of row) if (cell !== ".") expect(palette[cell]).toBeDefined();
      }
    }
  });
});
