import type { RuntimeKind } from "@hobbots/domain";
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

/** Each provider's potion fill and its lighter top. */
export const POTION_COLORS: Readonly<Record<RuntimeKind, readonly [fill: string, top: string]>> = {
  "claude-code": ["#e39a74", "#f3c4a8"],
  codex: ["#7fd1b9", "#b5ecd9"],
};

/** A plan that reports nothing shows an empty grey bottle. */
export const UNREPORTED_POTION = ["#3a3666", "#3a3666"] as const;

// The glass reads the theme's tokens, so the bottle keeps its outline on a light card too.
export const potionPalette = (fill: string, top: string): PixelPalette => ({
  k: "#a9774a",
  g: "var(--color-line-2)",
  e: "var(--color-deep)",
  f: fill,
  t: top,
});

/** The 5 × 5 name and look die. */
export const DIE: PixelRows = ["owwwo", "wwwww", "wwoww", "wwwww", "owwwo"];
export const DIE_PALETTE: PixelPalette = { o: "#141228", w: "#ece8ff" };

/** The Elder Hob, who guides setup. */
export const ELDER: PixelRows = [
  "...hhhh...",
  "..hhhhhh..",
  ".hhhhhhhh.",
  "s.ssssss.s",
  "ssksssskss",
  ".swwwwwws.",
  "..wwwwww..",
  "..cwwwwc..",
  ".cccwwccc.",
  "..bb..bb..",
];
export const ELDER_PALETTE: PixelPalette = {
  h: "#4a3a6a",
  s: "#e8b98f",
  k: "#141228",
  w: "#ece8ff",
  c: "#6b5aa8",
  b: "#2a1f18",
};
