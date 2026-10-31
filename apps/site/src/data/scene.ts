import type { HobColor } from "@hobbots/art/look";
import type { PixelPalette, PixelRows } from "@hobbots/art/pixels";

/**
 * The night village and the pixel icons on the coming soon page, from board 1 of the design canvas.
 * Everything is fixed, so the page looks the same on every visit.
 */

export interface Star {
  /** Percent of the width. */
  readonly x: number;
  /** Pixels from the top. */
  readonly y: number;
  readonly size: number;
  readonly delay: number;
}

export const HERO_STARS: ReadonlyArray<Star> = Array.from({ length: 60 }, (_, i) => ({
  x: ((i * 211 + 37) % 997) / 10,
  y: (i * 47 + 11) % 420,
  size: i % 4 === 0 ? 4 : 2,
  delay: (i % 6) * 0.5,
}));

export const ROLL_STARS: ReadonlyArray<Star> = Array.from({ length: 24 }, (_, i) => ({
  x: ((i * 173 + 59) % 991) / 10,
  y: (i * 61 + 23) % 520,
  size: 2,
  delay: (i % 5) * 0.6,
}));

export interface Firefly {
  readonly x: number;
  readonly y: number;
  readonly delay: number;
}

export const HERO_FIREFLIES: ReadonlyArray<Firefly> = Array.from({ length: 14 }, (_, i) => ({
  x: 6 + ((i * 97) % 88),
  y: 150 + ((i * 37) % 110),
  delay: (i % 5) * 0.9,
}));

export const ROLL_FIREFLIES: ReadonlyArray<Firefly> = [
  { x: 12, y: 40, delay: 0 },
  { x: 80, y: 60, delay: 1.2 },
  { x: 30, y: 120, delay: 2.1 },
  { x: 70, y: 140, delay: 0.6 },
  { x: 52, y: 30, delay: 1.7 },
  { x: 90, y: 110, delay: 2.6 },
];

export interface House {
  /** Left edge, in percent of the width. */
  readonly x: number;
  readonly width: number;
  readonly height: number;
  readonly roof: number;
  readonly chimney: number;
  readonly smoke: readonly [number, number];
  readonly lights: readonly [number, number];
  /** Narrow screens show only the first house. */
  readonly wide: boolean;
}

export const HOUSES: ReadonlyArray<House> = [
  { x: 5, width: 210, height: 136, roof: 68, chimney: 88, smoke: [0, 1.5], lights: [0.5, 0.8], wide: false },
  { x: 24, width: 160, height: 106, roof: 54, chimney: 72, smoke: [0.7, 2.1], lights: [1, 1.2], wide: true },
  { x: 76, width: 230, height: 146, roof: 74, chimney: 94, smoke: [1.2, 2.6], lights: [1.4, 1.7], wide: true },
];

export interface VillageHob {
  readonly id: string;
  readonly name: string;
  readonly seed: number;
  readonly color: HobColor;
  /** When it walks in, and where its idle bob starts. */
  readonly walk: number;
  readonly bob: number;
  /** What it says each time it is clicked, in turn. */
  readonly lines: ReadonlyArray<string>;
  /** Notes of its chirp, in hertz. */
  readonly chirp: ReadonlyArray<number>;
}

export const VILLAGE_HOBS: ReadonlyArray<VillageHob> = [
  {
    id: "pip",
    name: "Pip",
    seed: 11,
    color: "violet",
    walk: 0.6,
    bob: 0,
    lines: ["Hi! I’m Pip.", "Need a hand?", "I love a tidy inbox.", "Boop!"],
    chirp: [784, 988, 880],
  },
  {
    id: "bramble",
    name: "Bramble",
    seed: 27,
    color: "moss",
    walk: 0.9,
    bob: 0.4,
    lines: ["Hello there.", "I’ll look it up.", "Curious, isn’t it?"],
    chirp: [440, 392],
  },
  {
    id: "tinker",
    name: "Tinker",
    seed: 42,
    color: "amber",
    walk: 1.2,
    bob: 0.8,
    lines: ["Yawn…", "Hmph. Hi.", "Tests first."],
    chirp: [262, 247, 294],
  },
];

const OS_ROWS = {
  mac: [
    "............",
    ".##########.",
    ".#oooooooo#.",
    ".#oooooooo#.",
    ".#oooooooo#.",
    ".#oooooooo#.",
    ".#oooooooo#.",
    ".##########.",
    "############",
    ".##########.",
    "............",
    "............",
  ],
  linux: [
    "....####....",
    "...######...",
    "...#w##w#...",
    "...#kwwk#...",
    "...#wyyw#...",
    "..##wwww##..",
    "..#wwwwww#..",
    ".##wwwwww##.",
    ".##wwwwww##.",
    "..#wwwwww#..",
    "..yy####yy..",
    "............",
  ],
  windows: [
    "............",
    ".####..####.",
    ".####..####.",
    ".####..####.",
    ".####..####.",
    "............",
    "............",
    ".####..####.",
    ".####..####.",
    ".####..####.",
    ".####..####.",
    "............",
  ],
  mobile: [
    "...######...",
    "...#oooo#...",
    "...#oooo#...",
    "...#oooo#...",
    "...#oooo#...",
    "...#oooo#...",
    "...#oooo#...",
    "...#oooo#...",
    "...#oooo#...",
    "...######...",
    "...##ww##...",
    "............",
  ],
} satisfies Record<string, PixelRows>;

export type OsIcon = keyof typeof OS_ROWS;

const OS_PALETTES: Record<OsIcon, PixelPalette> = {
  mac: { "#": "#c9c3e8", o: "#3a3666" },
  linux: { "#": "#7770c4", w: "#ece8ff", k: "#141228", y: "#f2a541" },
  windows: { "#": "#c9c3e8" },
  mobile: { "#": "#c9c3e8", o: "#3a3666", w: "#7770c4" },
};

export const osIcon = (id: OsIcon) => ({ rows: OS_ROWS[id], palette: OS_PALETTES[id] });
