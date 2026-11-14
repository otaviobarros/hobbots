/**
 * The sidebar's layout classes, shared by the sidebar and the window frame index.html paints before
 * the app loads (app-frame.tsx), so the two line up. The sidebar is 276px from the wide breakpoint
 * and a 76px rail of icons below it, on 960 and 1024 wide windows (Design System › Sidebar).
 */

/** The column the sidebar takes in the window. */
export const sidebarColumn = "relative w-sidebar flex-none wide:w-sidebar-open";

/** The sidebar itself: a column that never hides; only its camps and direct messages scroll. */
export const sidebarNav = "flex h-full w-full flex-col overflow-hidden bg-panel max-wide:items-center";

/** The chief, the wordmark and Make a camp, at the top. */
export const sidebarTop =
  "flex w-full flex-none items-center gap-2.5 px-3 pt-3 pb-2 max-wide:justify-center max-wide:px-0";

/** A row of the narrow rail: a 48 × 44 hit area, the current one filled. */
export const sidebarIcon =
  "relative inline-flex h-11 w-12 flex-none items-center justify-center rounded-control text-text-secondary no-underline hover:bg-hover hover:text-text-strong aria-[current=page]:bg-selected aria-[current=page]:text-text-strong";

/** The hairline between the rail's groups. */
export const sidebarRule = "my-1.5 h-px w-9 flex-none bg-line wide:hidden";

/** A camp or direct message row: its face, its name and last line, then its counts; the face alone on the rail. */
export const sidebarRow =
  "relative grid w-full flex-none grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-control px-2 py-1.5 text-start text-text-strong no-underline hover:bg-hover aria-[current=page]:bg-selected max-wide:flex max-wide:h-11 max-wide:w-12 max-wide:justify-center max-wide:p-0";

/** A section's heading: its label and its + button. Only the wide sidebar shows it. */
export const sidebarSection = "flex w-full flex-none items-center gap-1.5 pt-3 pe-2 pb-1 ps-2.5 max-wide:hidden";

/** Show more under the camps, and All your hobs under the direct messages. */
export const sidebarMore =
  "flex w-full flex-none cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent py-1.5 ps-[54px] pe-2.5 text-start text-detail text-text-secondary no-underline hover:bg-hover hover:text-text-strong aria-[current=page]:bg-selected max-wide:hidden";

/** A count on a row: replies you have not read, or `@` in lantern for a mention of you. */
export const sidebarCount =
  "min-w-[18px] rounded-[9px] bg-[color-mix(in_srgb,var(--color-text-strong)_14%,transparent)] px-[5px] text-center text-meta font-bold text-text-strong";
