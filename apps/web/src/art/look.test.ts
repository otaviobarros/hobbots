import { describe, expect, it } from "vitest";
import { hobLook } from "./look.ts";

describe("hobLook", () => {
  it("draws the same hob for the same seed and color", () => {
    expect(hobLook(4821, "violet")).toEqual(hobLook(4821, "violet"));
  });

  it("draws a 14 × 14 grid whose every pixel has a color", () => {
    const look = hobLook(77, "ember");
    expect(look.rows).toHaveLength(14);
    for (const row of look.rows) {
      expect(row).toHaveLength(14);
      for (const ch of row) if (ch !== ".") expect(look.palette[ch]).toBeDefined();
    }
  });

  it("gives different seeds different looks", () => {
    const looks = new Set(Array.from({ length: 20 }, (_, seed) => hobLook(seed, "moss").rows.join("")));
    expect(looks.size).toBeGreaterThan(15);
  });

  it("changes only the colors when the color changes", () => {
    expect(hobLook(9, "sky").rows).toEqual(hobLook(9, "rose").rows);
    expect(hobLook(9, "sky").palette.h).not.toEqual(hobLook(9, "rose").palette.h);
  });
});
