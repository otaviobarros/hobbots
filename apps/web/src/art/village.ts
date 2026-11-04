import type { HobColor } from "@hobbots/domain";

/**
 * What stands and glows in the night village on Welcome. Everything is fixed, so the village looks
 * the same on every launch. Places are pixels in the 1280 × 800 scene (see welcome-scene.ts), which
 * Welcome scales to cover the window.
 */

/** The intro plays once, then only the quiet idle loop runs. Delays are in seconds. */
export interface Intro {
  readonly title: number;
  readonly tagline: number;
  readonly actions: number;
  readonly providers: number;
}

export const intro: Intro = { title: 0.2, tagline: 1.3, actions: 1.6, providers: 2.2 };

/** A place in the scene, and when its animation starts. */
export interface ScenePoint {
  readonly left: number;
  readonly top: number;
  readonly delay: number;
}

/** The warm glow around each lit window, in two sizes: the far houses' small ones and the near houses' large ones. */
export const WINDOW_GLOWS: ReadonlyArray<ScenePoint & { readonly size: number }> = [
  { left: 242, top: 442, size: 36, delay: 0 },
  { left: 690, top: 474, size: 36, delay: 0.7 },
  { left: 1122, top: 490, size: 36, delay: 1.4 },
  { left: -2, top: 486, size: 140, delay: 2.1 },
  { left: 54, top: 486, size: 140, delay: 2.8 },
  { left: 230, top: 526, size: 140, delay: 0.5 },
  { left: 966, top: 502, size: 140, delay: 1.2 },
  { left: 1022, top: 502, size: 140, delay: 1.9 },
  { left: 1174, top: 542, size: 140, delay: 2.6 },
];

/** The chimneys that smoke, each with when its puffs rise. */
export const CHIMNEYS: ReadonlyArray<{
  readonly left: number;
  readonly top: number;
  readonly puffs: ReadonlyArray<number>;
}> = [
  { left: 186, top: 448, puffs: [0, 1.3, 2.6] },
  { left: 338, top: 488, puffs: [0.4, 1.7, 3] },
  { left: 1138, top: 464, puffs: [0.8, 2.1] },
];

export const FIREFLIES: ReadonlyArray<ScenePoint> = [
  { left: 112, top: 528, delay: 0 },
  { left: 216, top: 576, delay: 0.55 },
  { left: 368, top: 504, delay: 1.1 },
  { left: 464, top: 584, delay: 1.65 },
  { left: 768, top: 560, delay: 2.2 },
  { left: 912, top: 512, delay: 2.75 },
  { left: 968, top: 592, delay: 3.3 },
  { left: 1168, top: 544, delay: 3.85 },
  { left: 704, top: 488, delay: 4.4 },
  { left: 64, top: 592, delay: 4.95 },
];

/** The brightest stars, which twinkle over the still ones drawn into the sky. */
export const TWINKLES: ReadonlyArray<ScenePoint> = [
  { left: 96, top: 64, delay: 0 },
  { left: 192, top: 240, delay: 0.4 },
  { left: 48, top: 368, delay: 0.8 },
  { left: 1200, top: 272, delay: 1.2 },
  { left: 944, top: 384, delay: 1.6 },
  { left: 1120, top: 400, delay: 2 },
  { left: 160, top: 144, delay: 2.4 },
  { left: 800, top: 416, delay: 2.8 },
];

export interface SceneHob {
  readonly name: string;
  readonly greeting: string;
  readonly lookSeed: number;
  readonly lookColor: HobColor;
  /** Where it stands on the path, in the scene's pixels. */
  readonly left: number;
  /** When it walks in during the intro, and where its idle bob starts. */
  readonly walk: number;
  readonly bob: number;
}

/** Three hobs walk into the village either side of the Chief, and say hi when you click them. */
export const SCENE_HOBS: ReadonlyArray<SceneHob> = [
  { name: "Pip", greeting: "Hi!", lookSeed: 11, lookColor: "violet", left: 300, walk: 0.6, bob: 0 },
  { name: "Bramble", greeting: "Hello!", lookSeed: 27, lookColor: "moss", left: 430, walk: 0.9, bob: 0.4 },
  { name: "Tinker", greeting: "Yawn…", lookSeed: 42, lookColor: "amber", left: 800, walk: 1.2, bob: 0.8 },
];

/**
 * The AI providers Hobbots is built to work with (RT-001). Setup shows which ones are found on
 * this computer and ready to use.
 */
export const PROVIDERS: ReadonlyArray<string> = ["Claude", "ChatGPT", "Gemini", "local models"];
