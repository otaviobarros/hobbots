/**
 * The window's layout classes, shared by the app, setup's local pages and the window frame
 * index.html paints before the app loads (app-frame.tsx), so they line up.
 */

/** The window: the title strip above whatever fills it. */
export const windowFrame = "flex h-screen min-h-[610px] flex-col bg-ground text-text-strong";

/** The desktop window's title bar, which macOS draws the traffic lights over and the window drags by. */
export const titleStrip =
  "flex h-title-strip flex-none items-center justify-center bg-deep text-detail text-label [-webkit-app-region:drag]";

/** The row under the title strip: the sidebar, then the page. */
export const windowBody = "flex min-h-0 flex-1";
