import { describe, expect, it } from "vitest";
import { clampHeight, DOCK_HEIGHT, DOCK_MIN, keyedHeight, parseHeight } from "./use-dock-height.ts";

describe("the docked Workbench's height", () => {
  it("stays between its strip and a few rows and three quarters of the room", () => {
    expect(clampHeight(40, 800)).toBe(DOCK_MIN);
    expect(clampHeight(420, 800)).toBe(420);
    expect(clampHeight(900, 800)).toBe(600);
    // A room too short for both keeps the dock at its least.
    expect(clampHeight(900, 100)).toBe(DOCK_MIN);
  });

  it("moves with the arrow keys, Home and End, and ignores any other key", () => {
    expect(keyedHeight("ArrowUp", 340, 800)).toBe(372);
    expect(keyedHeight("ArrowDown", 340, 800)).toBe(308);
    expect(keyedHeight("Home", 340, 800)).toBe(DOCK_MIN);
    expect(keyedHeight("End", 340, 800)).toBe(600);
    expect(keyedHeight("Enter", 340, 800)).toBeNull();
  });

  it("reads the height the device kept, and the design's height for anything else", () => {
    expect(parseHeight({ v: 1, height: 420 })).toBe(420);
    expect(parseHeight({ height: 420 })).toBe(DOCK_HEIGHT);
    expect(parseHeight(null)).toBe(DOCK_HEIGHT);
  });
});
