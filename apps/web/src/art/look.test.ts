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

  it("draws a hob without a role hat or tool exactly as its seed does", () => {
    expect(hobLook(4821, "violet", { hat: null, tool: null })).toEqual(hobLook(4821, "violet"));
    expect(hobLook(77, "ember").recipe).toBe(hobLook(77, "ember", {}).recipe);
  });

  it("dresses a hob in its role's hat and tool and keeps the rest of the seed's look", () => {
    for (let seed = 0; seed < 50; seed++) {
      const plain = hobLook(seed, "moss", { hat: "pointed", tool: "none" });
      const dressed = hobLook(seed, "moss", { hat: "crown", tool: "lantern" });
      expect(dressed.recipe).toBe("tiny crown, a lantern");
      // The hat fills the top five rows; the face below keeps the seed's picks.
      expect(dressed.rows.slice(0, 5)).not.toEqual(plain.rows.slice(0, 5));
      expect(dressed.rows.slice(5, 9).map((row) => row.slice(0, 11))).toEqual(
        plain.rows.slice(5, 9).map((row) => row.slice(0, 11)),
      );
      expect(dressed.palette).toEqual(plain.palette);
    }
  });
});
