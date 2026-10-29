import { describe, expect, it } from "vitest";
import { HOUSES, INTRO_MS, intro, PROVIDERS, SCENE_HOBS } from "./village.ts";

// Longest intro animations, in seconds (styles.css: hb-walk, hb-drop, hb-rise, hb-light).
const WALK = 2.4;
const DROP = 0.7;
const RISE = 0.6;
const LIGHT = 0.4;

describe("Welcome's village", () => {
  it("finishes the intro before Welcome counts it as played", () => {
    const ends = [
      ...SCENE_HOBS.map((hob) => hob.walk + WALK),
      ...intro.title.map((l) => l.delay + DROP),
      ...[intro.tagline, intro.actions, intro.providers].map((delay) => delay + RISE),
      ...HOUSES.flatMap((house) => house.lights.map((delay) => delay + LIGHT)),
    ];
    expect(Math.max(...ends) * 1000).toBeLessThanOrEqual(INTRO_MS);
  });

  it("spells the name and names the providers", () => {
    expect(intro.title.map((l) => l.letter).join("")).toBe("Hobbots");
    expect(PROVIDERS).toContain("Claude");
  });
});
