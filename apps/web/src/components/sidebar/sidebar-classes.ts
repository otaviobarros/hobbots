/**
 * The sidebar's layout classes, shared by the sidebar and the window frame index.html paints before
 * the app loads (app-frame.tsx), so the two line up.
 */

/** The column the sidebar takes in the window: 72px, or its expanded width from the wide breakpoint. */
export const sidebarColumn = "relative w-sidebar flex-none wide:w-auto";

/**
 * The sidebar itself. It collapses to 72px; expanded it is 256px, and below the wide breakpoint it
 * opens over the page.
 */
export const sidebarNav =
  "group/side flex h-full w-sidebar flex-col gap-0.5 overflow-hidden bg-panel p-3 transition-[width] duration-(--dur-sheet) data-[open=true]:w-sidebar-open max-wide:absolute max-wide:inset-y-0 max-wide:start-0 max-wide:z-30 max-wide:data-[open=true]:shadow-sheet";

/** The chief's row at the top of the sidebar. */
export const sidebarChief = "flex flex-none items-center gap-2 pb-2";

/** A sidebar row: a 48px icon column, then the label once the sidebar is expanded. */
export const sidebarItem =
  "relative flex min-h-row-min w-full flex-none items-center gap-2 rounded-control py-0.5 text-start text-body text-text-strong no-underline transition-colors duration-(--dur-fade) hover:bg-hover hover:text-text-strong focus-visible:-outline-offset-2 aria-[current=page]:bg-selected";

/** The icon column every row lines up on, so collapsed rows keep their place when it expands. */
export const sidebarIcon = "inline-flex no-underline w-12 flex-none items-center justify-center";

/** The line between the sections and the hobs. */
export const sidebarDivider = "mx-1.5 my-2 h-px flex-none bg-line";
