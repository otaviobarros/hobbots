import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CHIEF,
  cellSize,
  encodePng,
  iconGrid,
  LARGE,
  layoutFor,
  PALETTE,
  renderIcon,
  SMALL,
  SMALL_CHIEF,
} from "./app-icon.ts";

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) =>
  Array.from(rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));

const rgb = (color: string) => [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));

describe("app icon", () => {
  it("draws square art with every cell in the palette", () => {
    for (const art of [CHIEF, SMALL_CHIEF]) {
      for (const row of art) {
        expect(row).toHaveLength(art.length);
        for (const cell of row) expect(cell === "." || cell in PALETTE).toBe(true);
      }
    }
  });

  it("fits the art inside the tile edge", () => {
    for (const { art, cells, offset } of [SMALL, LARGE]) {
      expect(offset).toBeGreaterThanOrEqual(1);
      expect(offset + art.length).toBeLessThanOrEqual(cells - 1);
    }
  });

  it("keeps every pixel of the small chief at 16 px, one pixel per cell", () => {
    expect(layoutFor(16)).toBe(SMALL);
    expect(cellSize(16)).toBe(1);
    const rgba = renderIcon(16);
    // The 14-cell tile sits one pixel in from each edge of the canvas.
    iconGrid(SMALL).forEach((row, y) => {
      row.forEach((color, x) => {
        const [r, g, b, a] = pixel(rgba, 16, x + 1, y + 1);
        if (color === null) expect(a).toBe(0);
        else expect([r, g, b, a]).toEqual([...rgb(color), 255]);
      });
    });
    SMALL_CHIEF.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        const color = PALETTE[cell];
        if (color) expect(pixel(rgba, 16, 1 + SMALL.offset + x, 1 + SMALL.offset + y)).toEqual([...rgb(color), 255]);
      });
    });
    expect(pixel(rgba, 16, 0, 0)[3]).toBe(0);
  });

  it("draws the full chief at the same share of the canvas from 32 px up", () => {
    for (const size of [32, 64, 128, 256, 512, 1024]) {
      expect(layoutFor(size)).toBe(LARGE);
      expect(cellSize(size) * LARGE.cells).toBe((size * 26) / 32);
    }
    // The crown's center gem at 1024 px, 32 pixels per cell.
    const rgba = renderIcon(1024);
    const tileOffset = (1024 - 32 * LARGE.cells) / 2;
    const at = (cell: number) => tileOffset + (LARGE.offset + cell) * 32 + 16;
    expect(CHIEF[3]?.[7]).toBe("R");
    expect(pixel(rgba, 1024, at(7), at(3))).toEqual([...rgb(PALETTE.R ?? ""), 255]);
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
