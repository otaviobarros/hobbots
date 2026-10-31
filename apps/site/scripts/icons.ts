/**
 * Draws the site's favicons from the app icon's grid in `apps/desktop/scripts/app-icon.ts`, so the
 * browser tab and the Dock show the same chief on the same night sky.
 * Run `pnpm --filter @hobbots/site icons` after changing the art to regenerate the files in `public/`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng, iconGrid, LARGE, renderIcon } from "../../desktop/scripts/app-icon.ts";

/** The app icon as SVG: the sky as one rectangle, then one path per color, one unit per grid cell. */
export const iconSvg = () => {
  const grid = iconGrid(LARGE);
  const sky = grid[0]?.[0] ?? "#000";
  const paths = new Map<string, string>();
  grid.forEach((row, y) => {
    row.forEach((color, x) => {
      if (color !== sky) paths.set(color, `${paths.get(color) ?? ""}M${x} ${y}h1v1h-1z`);
    });
  });
  const body = [...paths].map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join("");
  const size = grid.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><title>Hobbots</title><rect width="${size}" height="${size}" fill="${sky}"/>${body}</svg>\n`;
};

/**
 * The Apple touch icon, 180 px. 180 is not a multiple of the 32-cell grid, so the icon is drawn at
 * 160 px (5 px cells) and framed by 10 px of sky.
 */
export const touchIcon = () => {
  const [size, inner, margin] = [180, 160, 10];
  const icon = renderIcon(inner);
  const rgba = new Uint8Array(size * size * 4);
  // The top-left cell is always sky.
  const sky = icon.subarray(0, 4);
  for (let i = 0; i < size * size; i++) rgba.set(sky, i * 4);
  for (let y = 0; y < inner; y++) {
    rgba.set(icon.subarray(y * inner * 4, (y + 1) * inner * 4), ((y + margin) * size + margin) * 4);
  }
  return encodePng(size, rgba);
};

/** An ICO file that wraps one PNG for each size, as browsers that skip the SVG icon expect. */
export const iconIco = (sizes: ReadonlyArray<number>) => {
  const images = sizes.map((size) => encodePng(size, renderIcon(size)));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((png, i) => {
    const entry = 6 + 16 * i;
    const size = sizes[i] ?? 0;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images]);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(import.meta.dirname, "../public");
  writeFileSync(join(out, "favicon.svg"), iconSvg());
  writeFileSync(join(out, "favicon.ico"), iconIco([16, 32]));
  writeFileSync(join(out, "apple-touch-icon.png"), touchIcon());
}
