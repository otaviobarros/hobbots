import type { HobColor } from "@hobbots/domain";

/**
 * The night village on Welcome, from the design's Welcome screen. Everything is fixed, so the
 * village looks the same on every launch. Positions across the window are percentages, so the
 * scene stretches with it; heights are pixels, measured up from the ground.
 */

/** The intro plays once, then only the quiet idle loop runs. Delays are in seconds. */
export interface Intro {
  readonly title: ReadonlyArray<{ readonly letter: string; readonly delay: number }>;
  readonly tagline: number;
  readonly actions: number;
  readonly providers: number;
}

export const intro: Intro = {
  title: [..."Hobbots"].map((letter, i) => ({ letter, delay: 0.2 + i * 0.09 })),
  tagline: 1.3,
  actions: 1.6,
  providers: 2.2,
};

export interface House {
  /** Left edge, in percent of the window width. */
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly roof: number;
  readonly chimney: number;
  /** When each window lights up during the intro, and when each puff of smoke rises. */
  readonly lights: readonly [number, number];
  readonly smoke: readonly [number, number];
}

export const HOUSES: ReadonlyArray<House> = [
  { left: 7, width: 220, height: 140, roof: 70, chimney: 90, lights: [0.5, 0.8], smoke: [0, 1.5] },
  { left: 26.5, width: 170, height: 110, roof: 56, chimney: 74, lights: [1, 1.2], smoke: [0.7, 2.1] },
  { left: 75, width: 240, height: 150, roof: 76, chimney: 96, lights: [1.4, 1.7], smoke: [1.2, 2.6] },
];

export interface SceneHob {
  readonly name: string;
  readonly greeting: string;
  readonly lookSeed: number;
  readonly lookColor: HobColor;
  /** When it walks in during the intro, and where its idle bob starts. */
  readonly walk: number;
  readonly bob: number;
}

/** Three hobs walk into the village, and say hi when you click them. */
export const SCENE_HOBS: ReadonlyArray<SceneHob> = [
  { name: "Pip", greeting: "Hi!", lookSeed: 11, lookColor: "violet", walk: 0.6, bob: 0 },
  { name: "Bramble", greeting: "Hello!", lookSeed: 27, lookColor: "moss", walk: 0.9, bob: 0.4 },
  { name: "Tinker", greeting: "Yawn…", lookSeed: 42, lookColor: "amber", walk: 1.2, bob: 0.8 },
];

/** A small fixed-seed generator, so the sky and the fireflies never move between launches. */
const sequence = (seed: number) => {
  let a = seed;
  return () => {
    a = (a * 16807) % 2147483647;
    return a / 2147483647;
  };
};

export interface Firefly {
  readonly left: number;
  /** Pixels above the ground. */
  readonly bottom: number;
  readonly delay: number;
}

export const FIREFLIES: ReadonlyArray<Firefly> = (() => {
  const next = sequence(13);
  return Array.from({ length: 12 }, (_, i) => ({
    left: Math.round((8 + next() * 84) * 10) / 10,
    bottom: Math.round(180 + next() * 120),
    delay: (i % 5) * 0.9,
  }));
})();

/**
 * The AI providers Hobbots is built to work with (RT-001). Setup shows which ones are found on
 * this computer and ready to use.
 */
export const PROVIDERS: ReadonlyArray<string> = ["Claude", "ChatGPT", "Gemini", "Grok", "Local models", "and more"];
