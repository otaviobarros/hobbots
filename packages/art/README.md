# packages/art

The pixel art that the app (`apps/web`, `apps/desktop`) and the website (`apps/site`) both draw, so they always look the same. Plain data and pure functions: no React, no DOM and no I/O. It depends only on `@hobbots/domain`, for the hob color, hat and tool types.

| Module      | What it holds                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `look.ts`   | `hobLook`, the seeded hob avatar generator, and the six `HOB_COLORS`.                                                                                                                |
| `chief.ts`  | The chief of the hobs: the Hobbots mark and app icon, with its gaze, staff and lantern frames. Free of imports, so `apps/desktop/scripts/app-icon.ts` loads it straight from source. |
| `moon.ts`   | The crescent moon over the night sky.                                                                                                                                                |
| `pixels.ts` | The `PixelRows` and `PixelPalette` types and `pixelPaths`, which turns a drawing into one SVG path per color.                                                                        |

Import a module by name, for example `import { hobLook } from "@hobbots/art/look"`.
