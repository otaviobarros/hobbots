/**
 * Draws the Hobbots app icon: the chief of the hobs, an elder hob in a gem crown with a long beard,
 * a royal robe and cape and a lantern staff, on a starry night tile with pixel corners.
 *
 * The chief is built from the seeded hob generator's parts (`apps/web/src/art/look.ts`): its tiny
 * crown, long beard, robe with trim, staff and lantern, in the Violet hob colors and the night
 * palette. Every size is drawn from a pixel grid with whole-pixel cells, never scaled from a large
 * image: 16 px uses a simplified chief, every larger size the full one.
 * Run `pnpm --filter @hobbots/desktop icon` (Node 22.18 or later, for type stripping) to
 * regenerate `resources/icon.icns` and `resources/icon.png` after changing the art.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

/** One palette for both drawings; "." is the tile behind the chief. */
export const PALETTE: Readonly<Record<string, string>> = {
  Y: "#f2a541", // crown and medallion: Lantern
  o: "#7fd1b9", // gems: Mint
  R: "#ee9292", // center gem: Rose
  y: "#f3e9b5", // lantern frame and stars: Moonlight
  L: "#ffd28a", // lantern light
  n: "#7a5b3a", // staff
  s: "#e8b98f", // skin
  S: "#c98f6a", // nose
  p: "#ee9292", // blush
  k: "#141228", // eyes
  w: "#ece8ff", // beard and brows
  W: "#c9c3e8", // beard shading
  M: "#b5523f", // mouth
  c: "#8a6fd8", // robe: Violet hat
  C: "#4b5fa8", // cape: Violet coat
  t: "#b9a5f0", // trim: Violet trim
  b: "#2a1f18", // boots
};

/** The full chief, 20 × 20 cells, for 32 px and up. */
export const CHIEF = [
  "...Y...YY...Y....nn.",
  "...YY.YYYY.YY...nyyn",
  "...YYYYYYYYYY...yLLy",
  "...YoYYRRYYoY...yLLy",
  "..ssssssssssss..nyyn",
  "ssswwwsssswwwsss.nn.",
  ".ssskssssssksss..n..",
  "..spkssSSsskps...n..",
  "..wwwwwMMwwwww...n..",
  ".CtwwwwwwwwwwtC..n..",
  "CCctwwwWWwwwtcCC.n..",
  "CCcctwwwwwwtccccsss.",
  "CCccctwwwwtcccCC.n..",
  "CCcccctwwtccccCC.n..",
  "CCcccccwwcccccCC.n..",
  "CCccccYooYccccCC.n..",
  "CCcccccYYcccccCC.n..",
  "CCccccccccccccCC.n..",
  "CCttttttttttttCC.n..",
  "...bbb....bbb....n..",
] as const;

/** The same chief in 12 × 12 cells, one pixel each, for the 16 px Finder list. */
export const SMALL_CHIEF = [
  ".Y..Y..Y..n.",
  ".YYYYYYY.yLy",
  ".YoYRYoY..n.",
  "sssssssss.n.",
  ".sksssks..n.",
  ".swwMwws..n.",
  "CtwwwwwtC.n.",
  "Cctwwwtccsn.",
  "CcctwtccC.n.",
  "CcccYcccC.n.",
  "CtttttttC.n.",
  ".bb...bb..n.",
] as const;

const GROUND = "#141228";
const EDGE = "#3a3666";
const STAR = "#f3e9b5";

interface Layout {
  readonly art: ReadonlyArray<string>;
  /** Cells across the tile, edge included. */
  readonly cells: number;
  /** Where the art's top-left cell sits in the tile. */
  readonly offset: number;
  readonly stars: ReadonlyArray<readonly [x: number, y: number]>;
}

/** 16 px: a 14-cell tile, one pixel per cell, with the art one cell in from the edge. */
export const SMALL: Layout = { art: SMALL_CHIEF, cells: 14, offset: 1, stars: [] };

/**
 * 32 px and up: a 26-cell tile at size / 32 pixels per cell, 26/32 of the canvas (832 of 1024,
 * close to the 824 px body of the macOS icon grid) at every size, so 1× and 2× match.
 */
export const LARGE: Layout = {
  art: CHIEF,
  cells: 26,
  offset: 3,
  stars: [
    [2, 3],
    [4, 1],
    [1, 9],
    [24, 15],
    [23, 21],
  ],
};

export const layoutFor = (size: number) => (size < 32 ? SMALL : LARGE);

/** Pixels per grid cell at a canvas size. */
export const cellSize = (size: number) => (size < 32 ? 1 : Math.floor(size / 32));

/** The tile, stars and chief on one grid of colors; `null` is transparent. */
export const iconGrid = ({ art, cells, offset, stars }: Layout): ReadonlyArray<ReadonlyArray<string | null>> =>
  Array.from({ length: cells }, (_, y) =>
    Array.from({ length: cells }, (_, x) => {
      const last = cells - 1;
      if ((x === 0 || x === last) && (y === 0 || y === last)) return null;
      if (x === 0 || y === 0 || x === last || y === last) return EDGE;
      const cell = art[y - offset]?.[x - offset];
      if (cell && PALETTE[cell]) return PALETTE[cell];
      return stars.some(([sx, sy]) => sx === x && sy === y) ? STAR : GROUND;
    }),
  );

/** Renders the icon as RGBA pixels, `size` × `size`, centered on a transparent canvas. */
export const renderIcon = (size: number): Uint8Array => {
  const layout = layoutFor(size);
  const cell = cellSize(size);
  const offset = Math.floor((size - cell * layout.cells) / 2);
  const rgba = new Uint8Array(size * size * 4);
  iconGrid(layout).forEach((row, gy) => {
    row.forEach((color, gx) => {
      if (!color) return;
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const at = ((offset + gy * cell + y) * size + offset + gx * cell + x) * 4;
          rgba.set([r ?? 0, g ?? 0, b ?? 0, 255], at);
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
