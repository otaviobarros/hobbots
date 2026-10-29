/**
 * The chief of the hobs: an elder hob in a gem crown with a long beard, a royal robe and cape and a
 * lantern staff, built from the seeded hob generator's parts (`look.ts`) in the Violet hob colors.
 *
 * The one source of the Hobbots mark: the rail draws it, and `apps/desktop/scripts/app-icon.ts`
 * draws the app icon from it. Keep this file free of imports so that script can load it directly.
 */

/** One palette for both drawings; "." is transparent. */
export const CHIEF_PALETTE: Readonly<Record<string, string>> = {
  Y: "#f2a541", // crown and medallion: Lantern
  o: "#7fd1b9", // gems: Mint
  R: "#ee9292", // center gem: Rose
  y: "#f3e9b5", // lantern frame: Moonlight
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

/** The full chief, 20 × 20 cells. */
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

/** The same chief in 12 × 12 cells, for one pixel per cell at 16 px. */
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

/** Where the chief looks in a frame of the rail's idle loop. */
export type ChiefGaze = "ahead" | "left" | "right" | "blink";

/** Each eye of the full chief, two cells tall: [column, top row]. */
const EYES = [
  [4, 6],
  [11, 6],
] as const;

/**
 * The full chief with its eyes moved one cell to a side, or closed to a line for a blink. The skin
 * fills where the eyes were; every other cell stays as drawn.
 */
export const chiefFrame = (gaze: ChiefGaze): ReadonlyArray<string> => {
  if (gaze === "ahead") return CHIEF;
  const rows = CHIEF.map((row) => [...row]);
  const shift = gaze === "left" ? -1 : gaze === "right" ? 1 : 0;
  for (const [x, y] of EYES) {
    for (const row of [y, y + 1]) {
      const cells = rows[row];
      if (cells) cells[x] = "s";
    }
    if (gaze === "blink") {
      const lid = rows[y + 1];
      if (lid) lid[x] = "k";
      continue;
    }
    for (const row of [y, y + 1]) {
      const cells = rows[row];
      if (cells) cells[x + shift] = "k";
    }
  }
  return rows.map((row) => row.join(""));
};

/** The staff, lantern and the hand that holds them start at this column of the full chief. */
const STAFF_COLUMN = 16;

/** The chief without the staff, so the staff can be raised on its own. */
export const chiefBody = (rows: ReadonlyArray<string>): ReadonlyArray<string> =>
  rows.map((row) => row.slice(0, STAFF_COLUMN) + ".".repeat(row.length - STAFF_COLUMN));

/** Only the staff, lantern and hand of the full chief. */
export const CHIEF_STAFF = CHIEF.map((row) => ".".repeat(STAFF_COLUMN) + row.slice(STAFF_COLUMN));

/** The lantern's light in a brighter flame, laid over the chief while a hob works. */
export const CHIEF_FLAME = CHIEF.map((row) => row.replace(/[^L]/g, "."));
export const CHIEF_FLAME_PALETTE: Readonly<Record<string, string>> = { L: "#fff4d6" };

/** The whole lantern blazing amber, laid over the chief when something needs you. */
export const CHIEF_BEACON = CHIEF.map((row) => row.replace(/[^yL]/g, "."));
export const CHIEF_BEACON_PALETTE: Readonly<Record<string, string>> = { y: "#ffb75c", L: "#fff4d6" };
