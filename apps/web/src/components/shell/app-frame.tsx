import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { sidebarColumn, sidebarIcon, sidebarNav, sidebarRow, sidebarTop } from "../sidebar/sidebar-classes.ts";
import { titleStrip, windowBody, windowFrame } from "./window-classes.ts";

/**
 * The window as it first paints, before the app's code has loaded (Patterns › Loading): the title
 * strip and the sidebar's fixed rows as still skeletons, in the sidebar's own layout. The build
 * renders it into index.html, so it shows at once, and the app's first render replaces it. It has
 * no state: public/first-paint.js marks the root element with what this device keeps, which the
 * `in-data-*` classes follow. `window="desktop"` shows the title strip, and `frame="plain"` leaves
 * the sidebar out on setup, Welcome and pairing.
 */
export function AppFrame() {
  return (
    <div aria-busy="true" className={windowFrame}>
      <header className={cn(titleStrip, "hidden in-data-[window=desktop]:flex")}>Hobbots</header>
      <div className={windowBody}>
        <FrameSidebar />
      </div>
    </div>
  );
}

/**
 * The sidebar's fixed rows as still skeletons, in its own layout: the chief, Find, the four places,
 * and two rows.
 */
function FrameSidebar() {
  return (
    <div aria-hidden="true" className={cn(sidebarColumn, "in-data-[frame=plain]:hidden")}>
      <div className={sidebarNav}>
        <div className={sidebarTop}>
          <Skeleton shape="tile" className="size-8" />
          <span className="flex-1 max-wide:hidden">
            <Skeleton width="9ch" />
          </span>
        </div>
        <div className="mx-3 mb-2 h-[34px] self-stretch max-wide:hidden">
          <Skeleton shape="tile" className="h-full w-full" />
        </div>
        <div className="flex w-full flex-none gap-0.5 px-2.5 pb-1.5 max-wide:flex-col max-wide:items-center max-wide:px-0">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className={cn(sidebarIcon, "wide:h-12 wide:flex-1")}>
              <Skeleton shape="dot" className="size-5" />
            </span>
          ))}
        </div>
        {[0, 1].map((index) => (
          <div key={index} className={cn(sidebarRow, "min-h-12 px-2")}>
            <Skeleton shape="tile" className="size-hob-tile max-wide:size-7.5" />
            <span className="max-wide:hidden">
              <Skeleton width="12ch" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
