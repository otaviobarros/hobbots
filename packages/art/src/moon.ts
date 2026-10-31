import type { PixelPalette, PixelRows } from "./pixels.ts";

/** The crescent moon over the night sky, 12 × 10 cells. */
export const MOON: PixelRows = [
  "....####....",
  "..###.......",
  ".###........",
  ".##.........",
  "###.........",
  "###.........",
  ".##.........",
  ".###........",
  "..###.......",
  "....####....",
];
export const MOON_PALETTE: PixelPalette = { "#": "#f3e9b5" };
