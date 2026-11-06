/**
 * The window's layout classes, shared by the app, setup's local pages and the window frame
 * index.html paints before the app loads (app-frame.tsx), so they line up.
 */

/**
 * The window: the title strip above whatever fills it. It clips what it holds, and is the box
 * anything placed absolutely in it is placed in, so nothing inside can make the window taller than
 * the frame and scroll it (#1026): each panel scrolls inside it instead.
 */
export const windowFrame = "relative flex h-screen min-h-[610px] flex-col overflow-clip bg-ground text-text-strong";

/** The desktop window's title bar, which macOS draws the traffic lights over and the window drags by. */
export const titleStrip =
  "flex h-title-strip flex-none items-center justify-center bg-deep text-detail text-label [-webkit-app-region:drag]";

/** The row under the title strip: the sidebar, then the page. */
export const windowBody = "flex min-h-0 flex-1";
