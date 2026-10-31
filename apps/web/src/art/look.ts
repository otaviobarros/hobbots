import type { HobColor, RoleHat, RoleTool } from "@hobbots/domain";
import type { PixelPalette, PixelRows } from "@hobbots/ui/components/pixel-art";

/**
 * The seeded hob avatar generator from the design's sprite sheet. The seed picks the hat,
 * gear, face, ears, beard, outfit and skin; the color comes from a fixed set of six. The same
 * seed and color always draw the same 14 × 14 hob, so the pair is saved with the hob. A role's
 * hat and tool, when the hob has them, replace the ones the seed picks and leave the rest as drawn.
 */

export interface HobLook {
  readonly rows: PixelRows;
  readonly palette: PixelPalette;
  /** Plain-words recipe, such as "wizard hat, a lantern". */
  readonly recipe: string;
}

export const HOB_COLORS: Readonly<Record<HobColor, { label: string; hat: string; coat: string; trim: string }>> = {
  violet: { label: "Violet", hat: "#8a6fd8", coat: "#4b5fa8", trim: "#b9a5f0" },
  moss: { label: "Moss", hat: "#5f9c5a", coat: "#7a5b3a", trim: "#9fd08f" },
  amber: { label: "Amber", hat: "#f2a541", coat: "#5d6573", trim: "#ffd28a" },
  rose: { label: "Rose", hat: "#ee9292", coat: "#6a3d5a", trim: "#f8c4c4" },
  sky: { label: "Sky", hat: "#6fb3d8", coat: "#3d5a7a", trim: "#b5dcf0" },
  ember: { label: "Ember", hat: "#d9653f", coat: "#3f3a4f", trim: "#f2a541" },
};

/** mulberry32: small, fast and stable across platforms. */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const HATS: Record<RoleHat, ReadonlyArray<string>> = {
  pointed: ["......hh......", ".....hhhh.....", "....hhhhhh....", "....hhhhhh....", "..hhhhhhhhhh.."],
  wizard: [".........hh...", "......hhhh....", ".....hhyhhh...", "....hhhhhyh...", "..hhhhhhhhhh.."],
  beanie: ["..............", "......tt......", "....hhhhhh....", "...hhhhhhhh...", "...tttttttt..."],
  hood: ["..............", ".....hhhh.....", "...hhhhhhhh...", "..hhhhhhhhhh..", "..hhhhhhhhhh.."],
  mushroom: ["..............", "....hhhhhh....", "..hhwhhhhwhh..", ".hhhhhhwhhhhh.", ".hwhhhhhhhhwh."],
  sprout: ["..............", "......gg......", ".......g......", "....rrrrrr....", "...rrrrrrrr..."],
  horned: ["..............", ".w..........w.", ".ww.hhhhhh.ww.", "..whhhhhhhhw..", "..tttttttttt.."],
  crown: ["..............", "...y..y..y....", "...yyyyyyy....", "...yoyyyoy....", "..rrrrrrrrrr.."],
};

const HAT_NAMES: Record<RoleHat, string> = {
  pointed: "pointy hat",
  wizard: "wizard hat",
  beanie: "woolly cap",
  hood: "hood",
  mushroom: "toadstool cap",
  sprout: "sprout",
  horned: "horned helm",
  crown: "tiny crown",
};

type Cell = readonly [y: number, x: number, color: string];

const GEAR: Record<RoleTool, ReadonlyArray<Cell>> = {
  wand: [
    [4, 12, "y"],
    [5, 11, "y"],
    [5, 13, "y"],
    [5, 12, "y"],
    [6, 12, "y"],
    [7, 12, "n"],
    [8, 12, "n"],
    [9, 12, "n"],
    [10, 12, "n"],
  ],
  staff: [
    [1, 12, "o"],
    [1, 13, "o"],
    [2, 12, "o"],
    [2, 13, "o"],
    [3, 12, "n"],
    [4, 12, "n"],
    [5, 12, "n"],
    [6, 12, "n"],
    [7, 12, "n"],
    [8, 12, "n"],
    [9, 12, "n"],
    [10, 12, "n"],
    [11, 12, "n"],
    [12, 12, "n"],
    [13, 12, "n"],
  ],
  lantern: [
    [9, 12, "n"],
    [10, 11, "n"],
    [10, 12, "y"],
    [10, 13, "n"],
    [11, 11, "n"],
    [11, 12, "y"],
    [11, 13, "n"],
    [12, 12, "n"],
  ],
  book: [
    [10, 11, "R"],
    [10, 12, "R"],
    [10, 13, "R"],
    [11, 11, "R"],
    [11, 12, "q"],
    [11, 13, "R"],
    [12, 11, "R"],
    [12, 12, "R"],
    [12, 13, "R"],
  ],
  quill: [
    [6, 13, "w"],
    [7, 12, "w"],
    [7, 13, "w"],
    [8, 12, "w"],
    [9, 12, "n"],
    [10, 12, "n"],
  ],
  wrench: [
    [7, 11, "i"],
    [7, 13, "i"],
    [8, 11, "i"],
    [8, 12, "i"],
    [8, 13, "i"],
    [9, 12, "i"],
    [10, 12, "i"],
    [11, 12, "i"],
  ],
  none: [],
};

const GEAR_NAMES: Record<RoleTool, string> = {
  wand: "a wand",
  staff: "a staff",
  lantern: "a lantern",
  book: "a spellbook",
  quill: "a quill",
  wrench: "a wrench",
  none: "empty hands",
};

const pickOr = <T>(chosen: T | null | undefined, seeded: T): T => chosen ?? seeded;

const SKINS = ["#e8b98f", "#d9a578", "#c98f6a", "#a8714f", "#f0c8a0", "#8d5a3c", "#a8c98f", "#c8b4e8"];
const HAIR = ["#2a1f18", "#7a4a2a", "#c9a24a", "#ece8ff", "#b5523f"];

/** The hat and tool a hob's role dresses it in; null or missing leaves the seed's pick. */
export interface HobGear {
  readonly hat?: RoleHat | null | undefined;
  readonly tool?: RoleTool | null | undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: predates the complexity limit (STD-ARCH-012). Split it before adding more branches.
export const hobLook = (seed: number, color: HobColor, gear: HobGear = {}): HobLook => {
  const next = rng(seed);
  const pick = <T>(list: ReadonlyArray<T>): T => list[Math.floor(next() * list.length)] as T;
  // Every pick runs even when the role overrides it, so the face and outfit stay the seed's.
  const hat = pickOr(gear.hat, pick(Object.keys(HATS) as Array<RoleHat>));
  const ears = pick(["none", "pointy", "pointy", "long"]);
  const eyes = pick(["dot", "dot", "big", "sleepy", "glasses"]);
  const beard = pick(["none", "none", "short", "long", "mustache"]);
  const body = pick(["tunic", "belt", "trim", "buttons", "robe"]);
  const item = pickOr(gear.tool, pick(Object.keys(GEAR) as Array<RoleTool>));
  const skin = pick(SKINS);
  const hair = pick(HAIR);
  const blush = next() < 0.4;

  const grid = [
    ...HATS[hat],
    "...ssssssss...",
    "...sEssssEs...",
    "...ssssssss...",
    "...sssMMsss...",
    "....ssssss....",
    "....cccccc....",
    "..scccccccccs.",
    "...cccccccc...",
    "....bb..bb....",
  ].map((row) => row.split(""));
  const set = (y: number, x: number, ch: string) => {
    const row = grid[y];
    if (row && x >= 0 && x < 14) row[x] = ch;
  };
  const stamp = (y: number, pattern: string) =>
    pattern.split("").forEach((ch, x) => {
      if (ch !== ".") set(y, x, ch);
    });

  if (hat === "hood")
    for (const y of [5, 6, 7, 8]) {
      set(y, 2, "h");
      set(y, 11, "h");
    }
  if (ears === "pointy" && hat !== "hood") {
    set(6, 2, "s");
    set(6, 11, "s");
    set(5, 2, "s");
    set(5, 11, "s");
  }
  if (ears === "long" && hat !== "hood") {
    set(6, 2, "s");
    set(6, 11, "s");
    set(5, 1, "s");
    set(5, 12, "s");
    set(6, 1, "s");
    set(6, 12, "s");
  }
  if (eyes === "dot") {
    set(6, 4, "k");
    set(6, 9, "k");
  }
  if (eyes === "big") {
    set(6, 4, "k");
    set(6, 9, "k");
    set(7, 4, "k");
    set(7, 9, "k");
    set(6, 5, "W");
    set(6, 8, "W");
  }
  if (eyes === "sleepy") {
    set(6, 4, "s");
    set(6, 9, "s");
    set(7, 4, "k");
    set(7, 5, "k");
    set(7, 8, "k");
    set(7, 9, "k");
  }
  if (eyes === "glasses") stamp(6, "...gkggggkg...");
  if (blush) {
    set(8, 3, "p");
    set(8, 10, "p");
  }
  if (beard === "short") {
    stamp(8, "...swwMMwws...");
    stamp(9, "....wwwwww....");
  }
  if (beard === "long") {
    stamp(8, "...swwwwwws...");
    set(8, 6, "M");
    set(8, 7, "M");
    stamp(9, "....wwwwww....");
    for (const x of [5, 6, 7, 8]) set(10, x, "w");
    for (const x of [6, 7]) set(11, x, "w");
  }
  if (beard === "mustache") for (const x of [5, 6, 7, 8]) set(8, x, "w");
  if (body === "belt") stamp(12, "...cllllllc...");
  if (body === "trim") stamp(12, "...tttttttt...");
  if (body === "buttons") {
    set(10, 7, "y");
    set(11, 7, "y");
    set(12, 7, "y");
  }
  if (body === "robe") {
    stamp(12, "..cccccccccc..");
    stamp(13, "..ctttttttc...");
    set(13, 11, "c");
  }
  for (const [y, x, ch] of GEAR[item]) set(y, x, ch);
  if (item !== "none") set(11, 12, "s");

  const colors = HOB_COLORS[color];
  return {
    rows: grid.map((row) => row.join("")),
    palette: {
      h: colors.hat,
      c: colors.coat,
      t: colors.trim,
      s: skin,
      E: skin,
      r: hair,
      k: "#141228",
      M: "#b5523f",
      W: "#ece8ff",
      w: "#ece8ff",
      p: "#ee9292",
      b: "#2a1f18",
      l: "#2a1f18",
      y: "#f3e9b5",
      o: "#7fd1b9",
      n: "#7a5b3a",
      g: "#7fbf6a",
      R: "#b5523f",
      q: "#ece8ff",
      i: "#a9a2e0",
    },
    recipe: `${HAT_NAMES[hat]}, ${GEAR_NAMES[item]}`,
  };
};
