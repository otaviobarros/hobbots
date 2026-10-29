import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CREST, CREST_PALETTE, cellSize, encodePng, iconGrid, renderIcon, TILE_CELLS } from "./app-icon.ts";

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));

describe("app icon", () => {
  it("draws the same crest as the web client", () => {
    const source = readFileSync(join(import.meta.dirname, "../../web/src/art/icons.ts"), "utf8");
    const block = source.match(/export const CREST: PixelRows = \[([^\]]*)\]/)?.[1] ?? "";
    expect([...block.matchAll(/"([^"]*)"/g)].map((m) => m[1])).toEqual([...CREST]);
    const palette = source.match(/export const CREST_PALETTE: PixelPalette = \{([^}]*)\}/)?.[1] ?? "";
    expect(Object.fromEntries([...palette.matchAll(/(\w+): "([^"]*)"/g)].map((m) => [m[1], m[2]]))).toEqual(
      CREST_PALETTE,
    );
  });

  it("keeps every crest pixel at 16 px, one pixel per cell", () => {
    expect(cellSize(16)).toBe(1);
    const rgba = renderIcon(16);
    const grid = iconGrid();
    // The 14-cell tile sits one pixel in from each edge.
    grid.forEach((row, y) => {
      row.forEach((color, x) => {
        const [r, g, b, a] = pixel(rgba, 16, x + 1, y + 1);
        if (color === null) expect(a).toBe(0);
        else expect([r, g, b, a]).toEqual([...[1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)), 255]);
      });
    });
    expect(pixel(rgba, 16, 0, 0)[3]).toBe(0);
  });

  it("draws the tile at the same share of the canvas at every iconset size", () => {
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      expect(cellSize(size) * TILE_CELLS).toBe((size * 14) / 16);
    }
  });

  it("encodes a PNG that decodes back to the same pixels", () => {
    const rgba = renderIcon(32);
    const png = encodePng(32, rgba);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(32);
    const idatLength = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    const rows = Array.from({ length: 32 }, (_, y) => raw.subarray(y * 129 + 1, (y + 1) * 129));
    expect(new Uint8Array(Buffer.concat(rows))).toEqual(rgba);
  });
});
