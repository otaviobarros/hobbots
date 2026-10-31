/**
 * Draws the README banner: the chief of the hobs and the three Welcome hobs on the night sky,
 * between two lit houses, under the word HOBBOTS. Everything comes from the app's own art
 * (`apps/web/src/art`) and the design tokens, so the banner changes when the art does.
 *
 * The scene is a grid of cells; each cell is CELL pixels, drawn as crisp SVG rectangles that
 * GitHub renders as an image. Run `node scripts/readme-banner.mjs` (Node 22.18 or later, for type
 * stripping) to regenerate `docs/assets/readme-banner.svg`; `readme-banner.test.mjs` fails when the
 * checked-in file is out of date.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHIEF, CHIEF_PALETTE } from "../apps/web/src/art/chief.ts";
import { hobLook } from "../apps/web/src/art/look.ts";
import { SCENE_HOBS } from "../apps/web/src/art/village.ts";

export const BANNER_PATH = join(import.meta.dirname, "../docs/assets/readme-banner.svg");

const CELL = 8;
const WIDTH = 160;
const HEIGHT = 50;
/** The first row of the ground; everything that stands, stands on it. */
const GROUND_ROW = 40;

const TOKENS = {
  ground: "#141228",
  line: "#2c2a5a",
  line2: "#3a3666",
  label: "#a9a2e0",
  secondary: "#c9c3e8",
  moonlight: "#f3e9b5",
  lantern: "#f2a541",
  lanternEdge: "#9a5f16",
  light: "#ffd28a",
  house: "#3d2f52",
  roof: "#2a1f3d",
};

/** A 5 × 7 pixel face for the letters of HOBBOTS; each pixel is drawn 2 × 2 cells. */
const LETTERS = {
  H: ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  O: [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  B: ["XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX."],
  T: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  S: [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
};

/** A small fixed-seed generator, so the stars never move between runs. */
const sequence = (seed) => {
  let a = seed;
  return () => {
    a = (a * 16807) % 2147483647;
    return a / 2147483647;
  };
};

const blankScene = () => Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(TOKENS.ground));

/** Paints character art onto the scene; "." and characters missing from the palette stay clear. */
const stamp = (scene, rows, palette, left, top, scale = 1) => {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = palette[ch];
      if (!color) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const line = scene[top + y * scale + dy];
          if (line && left + x * scale + dx < WIDTH) line[left + x * scale + dx] = color;
        }
    });
  });
};

const paintSky = (scene) => {
  const next = sequence(7);
  for (let i = 0; i < 70; i++) {
    const x = Math.floor(next() * WIDTH);
    const y = Math.floor(next() * 30);
    const behindTitle = y >= 2 && y <= 20 && x >= 34 && x <= 126;
    if (!behindTitle) scene[y][x] = next() < 0.3 ? TOKENS.moonlight : TOKENS.label;
  }
  const moon = [".mmmm.", "mmmmmm", "mmmmdm", "mmmmmm", "mdmmmm", ".mmmm."];
  stamp(scene, moon, { m: TOKENS.moonlight, d: TOKENS.secondary }, 146, 3);
};

const paintTitle = (scene) => {
  const word = "HOBBOTS";
  const left = Math.floor((WIDTH - (word.length * 12 - 2)) / 2);
  [...word].forEach((letter, i) => {
    stamp(scene, LETTERS[letter], { X: TOKENS.lanternEdge }, left + i * 12 + 1, 5, 2);
    stamp(scene, LETTERS[letter], { X: TOKENS.moonlight }, left + i * 12, 4, 2);
  });
};

const paintHouse = (scene, left, width, height) => {
  const top = GROUND_ROW - height;
  const roof = Array.from(
    { length: 5 },
    (_, i) => ".".repeat(4 - i) + "r".repeat(width - 8 + i * 2) + ".".repeat(4 - i),
  );
  stamp(scene, roof, { r: TOKENS.roof }, left, top - 5);
  stamp(scene, Array(height).fill("h".repeat(width)), { h: TOKENS.house }, left, top);
  stamp(scene, ["cc", "cc", "cc", "cc"], { c: TOKENS.roof }, left + width - 6, top - 8);
  const window = ["yyyyy", "yLyLy", "yyyyy", "yLyLy", "yyyyy"];
  stamp(scene, window, { y: TOKENS.lanternEdge, L: TOKENS.light }, left + 3, top + 2);
  stamp(scene, ["dddd", "dddd", "dddd", "dddd", "dddd"], { d: TOKENS.roof }, left + width - 9, GROUND_ROW - 5);
};

const paintGround = (scene) => {
  for (let y = GROUND_ROW; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) scene[y][x] = y === GROUND_ROW || y === 45 ? TOKENS.line2 : TOKENS.line;
};

const paintFolk = (scene) => {
  stamp(scene, CHIEF, CHIEF_PALETTE, 70, GROUND_ROW - CHIEF.length);
  // One spot per Welcome hob; a hob without a spot would silently go missing.
  const spots = [48, 96, 112];
  if (SCENE_HOBS.length !== spots.length) throw new Error("Give each Welcome hob a spot in the README banner.");
  SCENE_HOBS.forEach((hob, i) => {
    const { rows, palette } = hobLook(hob.lookSeed, hob.lookColor);
    stamp(scene, rows, palette, spots[i], GROUND_ROW - rows.length);
  });
  const fireflies = [
    [40, 27],
    [62, 31],
    [92, 25],
    [128, 30],
    [24, 23],
    [140, 26],
  ];
  for (const [x, y] of fireflies) scene[y][x] = TOKENS.lantern;
};

/** The whole scene as rows of colors. */
export const bannerGrid = () => {
  const scene = blankScene();
  paintSky(scene);
  paintTitle(scene);
  paintGround(scene);
  paintHouse(scene, 6, 26, 14);
  paintHouse(scene, 130, 22, 11);
  paintFolk(scene);
  return scene;
};

/** One rectangle per run of same-colored cells in a row keeps the file small. */
const rowRects = (row, y) => {
  const rects = [];
  let start = 0;
  for (let x = 1; x <= row.length; x++) {
    if (x < row.length && row[x] === row[start]) continue;
    rects.push(`<rect x="${start}" y="${y}" width="${x - start}" height="1" fill="${row[start]}"/>`);
    start = x;
  }
  return rects;
};

export const bannerSvg = () => {
  const rects = bannerGrid().flatMap(rowRects);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH * CELL}" height="${HEIGHT * CELL}" viewBox="0 0 ${WIDTH} ${HEIGHT}" shape-rendering="crispEdges" role="img" aria-labelledby="title">`,
    '<title id="title">Hobbots: the chief of the hobs and three hobs in a village at night, under a pixel-art title</title>',
    ...rects,
    "</svg>",
    "",
  ].join("\n");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(BANNER_PATH, bannerSvg());
