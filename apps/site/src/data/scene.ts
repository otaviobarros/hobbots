import type { HobColor } from "@hobbots/art/look";

/**
 * The night scenes on the launch page, from boards 4 and 5 of the design canvas.
 * Everything is fixed, so the page looks the same on every visit.
 */

export interface Star {
  /** Percent of the width. */
  readonly x: number;
  /** Percent of the height in the hero's stage, pixels from the top in the roller. */
  readonly y: number;
  readonly delay: number;
}

export const STAGE_STARS: ReadonlyArray<Star> = Array.from({ length: 16 }, (_, i) => ({
  x: ((i * 211 + 37) % 997) / 10,
  y: 6 + ((i * 47 + 11) % 38),
  delay: (i % 6) * 0.5,
}));

export const ROLL_STARS: ReadonlyArray<Star> = Array.from({ length: 24 }, (_, i) => ({
  x: ((i * 173 + 59) % 991) / 10,
  y: (i * 61 + 23) % 520,
  delay: (i % 5) * 0.6,
}));

export interface Firefly {
  readonly x: number;
  readonly y: number;
  readonly delay: number;
}

export const ROLL_FIREFLIES: ReadonlyArray<Firefly> = [
  { x: 12, y: 40, delay: 0 },
  { x: 80, y: 60, delay: 1.2 },
  { x: 30, y: 120, delay: 2.1 },
  { x: 70, y: 140, delay: 0.6 },
  { x: 52, y: 30, delay: 1.7 },
  { x: 90, y: 110, delay: 2.6 },
];

export interface CrewHob {
  readonly name: string;
  readonly seed: number;
  readonly color: HobColor;
}

/** Aldric's party in the hero's Quest. Ada asks the question; phones show the first four. */
export const CREW: ReadonlyArray<CrewHob> = [
  { name: "Aldric", seed: 4000, color: "amber" },
  { name: "Quill", seed: 4911, color: "sky" },
  { name: "Ada", seed: 5822, color: "moss" },
  { name: "Rook", seed: 6733, color: "amber" },
  { name: "Pip", seed: 7644, color: "sky" },
  { name: "Bram", seed: 8555, color: "moss" },
];
