import { describe, expect, it } from "vitest";
import { initialWindowBounds } from "../src/main/window-size.ts";

describe("the window's opening size", () => {
  it("covers 70% of a large display, centered", () => {
    expect(initialWindowBounds({ x: 0, y: 25, width: 3008, height: 1667 })).toEqual({
      x: 451,
      y: 275,
      width: 2106,
      height: 1167,
      minWidth: 960,
      minHeight: 610,
    });
  });

  it("keeps the preferred size where 70% would be smaller", () => {
    expect(initialWindowBounds({ x: 0, y: 33, width: 1728, height: 1084 })).toMatchObject({
      width: 1440,
      height: 900,
    });
  });

  it("stays inside a display smaller than the preferred size", () => {
    expect(initialWindowBounds({ x: 0, y: 25, width: 1280, height: 775 })).toEqual({
      x: 0,
      y: 25,
      width: 1280,
      height: 775,
      minWidth: 960,
      minHeight: 610,
    });
  });

  it("fills a work area smaller than the minimum size and lowers the minimum to fit it", () => {
    expect(initialWindowBounds({ x: 0, y: 25, width: 800, height: 575 })).toEqual({
      x: 0,
      y: 25,
      width: 800,
      height: 575,
      minWidth: 800,
      minHeight: 575,
    });
  });

  it("centers on a display to the side of the main one", () => {
    expect(initialWindowBounds({ x: -2560, y: 0, width: 2560, height: 1440 })).toMatchObject({ x: -2176, y: 216 });
  });
});
