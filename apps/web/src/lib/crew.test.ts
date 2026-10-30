import { describe, expect, it } from "vitest";
import { foldsByDefault, groupCrew, matchesHob, splitScene } from "./crew.ts";

describe("splitScene", () => {
  it("puts six hobs on stage and the rest in the hall", () => {
    const { stage, hall } = splitScene(Array.from({ length: 20 }, (_, i) => i));
    expect(stage).toEqual([0, 1, 2, 3, 4, 5]);
    expect(hall).toBe(14);
  });
  it("leaves the hall empty with six hobs or fewer", () => expect(splitScene([1, 2, 3]).hall).toBe(0));
});

describe("matchesHob", () => {
  const hob = { name: "Bramble", craft: "Researcher" };
  it("finds a hob by name", () => expect(matchesHob(hob, "bram")).toBe(true));
  it("finds a hob by craft, ignoring case and spaces", () => expect(matchesHob(hob, "  SEARCH ")).toBe(true));
  it("leaves out a hob that matches neither", () => expect(matchesHob(hob, "scribe")).toBe(false));
  it("matches every hob with an empty filter", () => expect(matchesHob(hob, " ")).toBe(true));
});

describe("groupCrew", () => {
  it("groups by state in list order and drops empty groups", () => {
    const crew = [
      { name: "Ada", state: "idle" as const },
      { name: "Bo", state: "paused" as const },
      { name: "Cy", state: "thinking" as const },
      { name: "Di", state: "working" as const },
      { name: "Ed", state: "idle" as const },
    ];
    expect(groupCrew(crew).map(({ group, members }) => [group, members.map((m) => m.name)])).toEqual([
      ["working", ["Cy", "Di"]],
      ["resting", ["Ada", "Ed"]],
      ["paused", ["Bo"]],
    ]);
  });
});

describe("foldsByDefault", () => {
  it("folds Resting past 12 hobs", () => {
    expect(foldsByDefault("resting", 12)).toBe(false);
    expect(foldsByDefault("resting", 13)).toBe(true);
  });
  it("never folds the other groups", () => expect(foldsByDefault("working", 40)).toBe(false));
});
