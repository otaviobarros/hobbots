/**
 * Draws the Hobbots app icon: the chief of the hobs (`apps/web/src/art/chief.ts`) on a starry night
 * sky that fills the whole canvas. macOS masks the icon to its own rounded shape; any transparent
 * margin makes macOS 26 and later shrink the icon onto a gray plate, so nothing here is transparent.
 *
 * Every size is drawn from a pixel grid with whole-pixel cells, never scaled from a large image:
 * 16 px uses the small chief, every larger size the full one.
 * Run `pnpm --filter @hobbots/desktop icon` (Node 22.18 or later, for type stripping) to
 * regenerate `resources/icon.icns` and `resources/icon.png` after changing the art.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { CHIEF, CHIEF_PALETTE as PALETTE, SMALL_CHIEF } from "../../web/src/art/chief.ts";

export { CHIEF, PALETTE, SMALL_CHIEF };

const GROUND = "#141228";
const STAR = "#f3e9b5";

interface Layout {
  readonly art: ReadonlyArray<string>;
  /** Cells across the canvas. */
  readonly cells: number;
  /** Where the art's top-left cell sits. */
  readonly offset: number;
  readonly stars: ReadonlyArray<readonly [x: number, y: number]>;
}

/** 16 px: 16 cells of one pixel, the small chief centered. */
export const SMALL: Layout = { art: SMALL_CHIEF, cells: 16, offset: 2, stars: [] };

/**
 * 32 px and up: 32 cells of size / 32 pixels, so 1× and 2× match. The chief is centered, well
 * inside the rounded corners macOS clips, and the stars stay clear of them too.
 */
export const LARGE: Layout = {
  art: CHIEF,
  cells: 32,
  offset: 6,
  stars: [
    [8, 4],
    [4, 9],
    [3, 16],
    [27, 11],
    [28, 19],
    [23, 27],
  ],
};

export const layoutFor = (size: number) => (size < 32 ? SMALL : LARGE);

/** Pixels per grid cell at a canvas size. */
export const cellSize = (size: number) => size / layoutFor(size).cells;

/** The sky, stars and chief on one grid of colors. */
export const iconGrid = ({ art, cells, offset, stars }: Layout): ReadonlyArray<ReadonlyArray<string>> =>
  Array.from({ length: cells }, (_, y) =>
    Array.from({ length: cells }, (_, x) => {
      const cell = art[y - offset]?.[x - offset];
      if (cell && PALETTE[cell]) return PALETTE[cell];
      return stars.some(([sx, sy]) => sx === x && sy === y) ? STAR : GROUND;
    }),
  );

/** Renders the icon as opaque RGBA pixels, `size` × `size`; `size` is 16 or a multiple of 32. */
export const renderIcon = (size: number): Uint8Array => {
  const cell = cellSize(size);
  const rgba = new Uint8Array(size * size * 4);
  iconGrid(layoutFor(size)).forEach((row, gy) => {
    row.forEach((color, gx) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          rgba.set([r ?? 0, g ?? 0, b ?? 0, 255], ((gy * cell + y) * size + gx * cell + x) * 4);
        }
      }
    });
  });
  return rgba;
};

const chunk = (type: string, data: Uint8Array) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** Encodes RGBA pixels as an 8-bit truecolor PNG with alpha. */
export const encodePng = (size: number, rgba: Uint8Array) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  // Each scanline starts with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
};

/** The iconset entries `iconutil` expects: each point size at 1× and 2×. */
const ICONSET = [16, 32, 128, 256, 512].flatMap((points) => [
  { name: `icon_${points}x${points}.png`, size: points },
  { name: `icon_${points}x${points}@2x.png`, size: points * 2 },
]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resources = join(import.meta.dirname, "../resources");
  const work = mkdtempSync(join(tmpdir(), "hobbots-icon-"));
  try {
    const iconset = join(work, "Hobbots.iconset");
    mkdirSync(iconset);
    for (const { name, size } of ICONSET) writeFileSync(join(iconset, name), encodePng(size, renderIcon(size)));
    mkdirSync(resources, { recursive: true });
    execFileSync("iconutil", ["--convert", "icns", "--output", join(resources, "icon.icns"), iconset]);
    writeFileSync(join(resources, "icon.png"), encodePng(1024, renderIcon(1024)));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
