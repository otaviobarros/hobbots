import type { PixelPalette, PixelRows } from "@hobbots/ui/components/pixel-art";

/** 12 × 12 rail icons from the Hobbots design: "#" is the main color, "o" the accent. */
export const ICONS = {
  Home: [
    "............",
    ".....##.#...",
    "....####....",
    "...######...",
    "..########..",
    ".##########.",
    "..#oo##oo#..",
    "..#oo##oo#..",
    "..########..",
    "..###..###..",
    "..###..###..",
    "............",
  ],
  Hobs: [
    "........#...",
    ".......##...",
    "......###...",
    ".....####...",
    "....#####...",
    "....######..",
    "...#######..",
    "...oooooooo.",
    ".##########.",
    "............",
    "....o..o....",
    "............",
  ],
  Inbox: [
    "............",
    "............",
    ".##########.",
    ".#o......o#.",
    ".#.o....o.#.",
    ".#..o..o..#.",
    ".#...oo...#.",
    ".#........#.",
    ".##########.",
    "............",
    "............",
    "............",
  ],
  Usage: [
    "....####....",
    ".....##.....",
    ".....##.....",
    "....#..#....",
    "...#....#...",
    "..#......#..",
    "..#oooooo#..",
    "..#oooooo#..",
    "..#oooooo#..",
    "...#oooo#...",
    "....####....",
    "............",
  ],
  Settings: [
    "............",
    ".....##.....",
    "..#.####.#..",
    "...######...",
    "..###..###..",
    ".###....###.",
    ".###....###.",
    "..###..###..",
    "...######...",
    "..#.####.#..",
    ".....##.....",
    "............",
  ],
  Quests: [
    "............",
    "..########..",
    ".#oooooooo#.",
    "..#......#..",
    "..#.####.#..",
    "..#......#..",
    "..#.###..#..",
    "..#......#..",
    ".#oooooooo#.",
    "..########..",
    "............",
    "............",
  ],
} satisfies Record<string, PixelRows>;

export type IconName = keyof typeof ICONS;

export const iconPalette = (active: boolean): PixelPalette =>
  active ? { "#": "#f3e9b5", o: "#f2a541" } : { "#": "#a9a2e0", o: "#7770c4" };

/** A 12 × 13 potion bottle; `left` (0..1) fills it from the bottom. */
export const potion = (left: number): PixelRows => {
  const rows = [
    "....####....",
    ".....##.....",
    "....####....",
    "....#..#....",
    "...#....#...",
    "..#......#..",
    ".#........#.",
    ".#........#.",
    ".#........#.",
    ".#........#.",
    ".#........#.",
    "..#......#..",
    "...######...",
  ];
  const firstFilled = 12 - Math.round(Math.min(1, Math.max(0, left)) * 7);
  return rows.map((row, y) => {
    const a = row.indexOf("#");
    const b = row.lastIndexOf("#");
    return row
      .split("")
      .map((ch, x) => {
        if (ch === "#") return y <= 2 ? "k" : "g";
        if (y >= 5 && x > a && x < b) return y >= firstFilled ? (y === firstFilled ? "t" : "f") : "e";
        return ".";
      })
      .join("");
  });
};

export const potionPalette = (fill: string, top: string): PixelPalette => ({
  k: "#a9774a",
  g: "#ece8ff",
  e: "#2c2a5a",
  f: fill,
  t: top,
});
