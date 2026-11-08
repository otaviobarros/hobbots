import { describe, expect, it } from "vitest";
import { CREW, ROLL_STARS, STAGE_STARS } from "../src/data/scene.ts";

describe("the night scenes", () => {
  it("keeps every star inside the sky", () => {
    for (const star of [...STAGE_STARS, ...ROLL_STARS]) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThan(100);
    }
    for (const star of STAGE_STARS) expect(star.y).toBeLessThan(50);
  });

  it("puts Ada, who asks the question, among the four hobs a phone shows", () => {
    expect(CREW.findIndex((hob) => hob.name === "Ada")).toBeLessThan(4);
  });
});
