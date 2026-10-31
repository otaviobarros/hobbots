import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BANNER_PATH, bannerGrid, bannerSvg } from "./readme-banner.mjs";

test("the checked-in README banner matches the art; run node scripts/readme-banner.mjs to update it", () => {
  assert.equal(readFileSync(BANNER_PATH, "utf8"), bannerSvg());
});

test("every cell of the banner is painted with a color", () => {
  const grid = bannerGrid();
  assert.equal(grid.length, 50);
  for (const row of grid) {
    assert.equal(row.length, 160);
    for (const color of row) assert.match(color, /^#[0-9a-f]{6}$/);
  }
});
