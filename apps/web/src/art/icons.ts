import type { PixelPalette, PixelRows } from "@hobbots/ui/components/pixel-art";

/** 12 × 12 sidebar icons from the Hobbots design: "#" is the main color, "o" the accent. */
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
  Memory: [
    "............",
    ".#########..",
    ".#ooooooo##.",
    ".#o#####o##.",
    ".#ooooooo##.",
    ".#o###ooo##.",
    ".#ooooooo##.",
    ".#ooooooo##.",
    ".#########..",
    ".##########.",
    "..#########.",
    "............",
  ],
  Skills: [
    "............",
    "........#...",
    ".......###..",
    "........#...",
    "....#.......",
    "...###......",
    "....#..#....",
    "......#.....",
    ".....#......",
    "....#.......",
    "...#........",
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

/** The sidebar's sections, each drawn twice: 20 × 20 line paths for Lamplight, pixel art for Workshop. */
export const LINE_ICONS = {
  Home: "M3 9.5 10 3.5l7 6M5 8v8.5h10V8M8.5 16.5v-4.5h3v4.5",
  Inbox: "M3 11.5 5 4.5h10l2 7v4.5H3zM3 11.5h4l1 2h4l1-2h4",
  Memory: "M4 3.5h10.5v11H5.5A1.5 1.5 0 0 0 4 16zM4 16a1.5 1.5 0 0 1 1.5-1.5h9M7.5 7h4M7.5 9.5h2.5",
  Skills:
    "M3.5 16.5 11 9M12.5 3.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8zM15.5 10.5l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z",
  Usage: "M3.5 16.5h13M5.5 16.5v-5M10 16.5v-10M14.5 16.5v-7",
  Settings:
    "M10 7.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4",
} as const satisfies Partial<Record<IconName, string>>;

export type SectionName = keyof typeof LINE_ICONS;

export const iconPalette = (active: boolean): PixelPalette =>
  active ? { "#": "#f3e9b5", o: "#f2a541" } : { "#": "#a9a2e0", o: "#7770c4" };

/** The Archive's chest, 12 × 8: a lid, a dark band and a brass clasp. */
export const ARCHIVE_CHEST: PixelRows = [
  "..aaaaaaaa..",
  ".abbbbbbbba.",
  "abbbbbbbbbba",
  "accccddcccca",
  "abbbbddbbbba",
  "abbbbbbbbbba",
  "abbbbbbbbbba",
  "aaaaaaaaaaaa",
];

export const archiveChestPalette: PixelPalette = { a: "#5a3d26", b: "#8a5d3a", c: "#3d2a1a", d: "#e8a54b" };

/** The Usage potion's cork, the same wood as the archive chest in every theme. */
export const POTION_CORK = { background: "#8a5d3a", boxShadow: "inset 0 -3px 0 #5a3d26" } as const;

/** The 5 × 5 name and look die. */
export const DIE: PixelRows = ["owwwo", "wwwww", "wwoww", "wwwww", "owwwo"];
export const DIE_PALETTE: PixelPalette = { o: "#141228", w: "#ece8ff" };
