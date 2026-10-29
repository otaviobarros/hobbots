/**
 * Draws the Hobbots app icon: the crest from the design, on a night tile with pixel corners.
 *
 * Every size is drawn from the pixel grid with whole-pixel cells, never scaled from a large
 * image, so the hob stays crisp from the 16 px Finder list to the 1024 px Get Info preview.
 * Run `pnpm --filter @hobbots/desktop icon` (Node 22.18 or later, for type stripping) to regenerate `resources/icon.icns` and
 * `resources/icon.png` after changing the art.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

/** The crest as drawn in `apps/web/src/art/icons.ts`; a test keeps the two in step. */
export const CREST = [
  "...hhhh...",
  "..hhhhhh..",
  ".hhhhhhhh.",
  "s.ssssss.s",
  "ssksssskss",
  ".ssssssss.",
  "..ssmmss..",
  "..cccccc..",
  ".cccccccc.",
  "..bb..bb..",
] as const;

/** Moonlight and lantern from the night palette, with Deep for the face. */
export const CREST_PALETTE: Record<string, string> = {
  h: "#f3e9b5",
  s: "#f3e9b5",
  k: "#0d0c1c",
  m: "#0d0c1c",
  c: "#f2a541",
  b: "#f2a541",
};

/** The 14 × 14 tile: Ground inside a Line 2 edge, with one clipped cell at each corner. */
export const TILE_CELLS = 14;
const GROUND = "#141228";
const EDGE = "#3a3666";
const CREST_OFFSET = 2;

/** The tile and the crest on one grid of colors; `null` is transparent. */
export const iconGrid = (): ReadonlyArray<ReadonlyArray<string | null>> =>
  Array.from({ length: TILE_CELLS }, (_, y) =>
    Array.from({ length: TILE_CELLS }, (_, x) => {
      const last = TILE_CELLS - 1;
      if ((x === 0 || x === last) && (y === 0 || y === last)) return null;
      if (x === 0 || y === 0 || x === last || y === last) return EDGE;
      const crest = CREST[y - CREST_OFFSET]?.[x - CREST_OFFSET];
      return (crest && CREST_PALETTE[crest]) ?? GROUND;
    }),
  );

/**
 * Pixels per grid cell: the 14-cell tile always covers 14/16 of the canvas, so the icon is the
 * same size at 1× and 2× and every cell is a whole number of pixels at each iconset size.
 */
export const cellSize = (size: number) => Math.max(1, Math.floor(size / 16));

/** Renders the icon as RGBA pixels, `size` × `size`, centered on a transparent canvas. */
export const renderIcon = (size: number): Uint8Array => {
  const cell = cellSize(size);
  const offset = Math.floor((size - cell * TILE_CELLS) / 2);
  const rgba = new Uint8Array(size * size * 4);
  iconGrid().forEach((row, gy) => {
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
