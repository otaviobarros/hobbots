import { describe, expect, it } from "vitest";
import { matchesHob, splitScene } from "./crew.ts";

describe("splitScene", () => {
  it("puts five hobs on stage and the rest in the hall", () => {
    const { stage, hall } = splitScene(Array.from({ length: 20 }, (_, i) => i));
    expect(stage).toEqual([0, 1, 2, 3, 4]);
    expect(hall).toBe(15);
  });
  it("leaves the hall empty with five hobs or fewer", () => expect(splitScene([1, 2, 3]).hall).toBe(0));
});

describe("matchesHob", () => {
  const hob = { name: "Bramble", roleTitle: "Researcher" };
  it("finds a hob by name", () => expect(matchesHob(hob, "bram")).toBe(true));
  it("finds a hob by role title, ignoring case and spaces", () => expect(matchesHob(hob, "  SEARCH ")).toBe(true));
  it("leaves out a hob that matches neither", () => expect(matchesHob(hob, "scribe")).toBe(false));
  it("matches every hob with an empty filter", () => expect(matchesHob(hob, " ")).toBe(true));
});
