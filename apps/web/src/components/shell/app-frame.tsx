import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import {
  sidebarChief,
  sidebarColumn,
  sidebarDivider,
  sidebarIcon,
  sidebarItem,
  sidebarNav,
} from "../sidebar/sidebar-classes.ts";
import { titleStrip, windowBody, windowFrame } from "./window-classes.ts";

/** The sections' rows, by the likely length of each label: Home, Inbox, Usage and Settings. */
const SECTION_WIDTHS = ["5ch", "5ch", "5ch", "8ch"] as const;

/**
 * The window as it first paints, before the app's code has loaded (Patterns › Loading): the title
 * strip and the sidebar's fixed rows as still skeletons, in the sidebar's own layout. The build
 * renders it into index.html, so it shows at once, and the app's first render replaces it. It has
 * no state: public/first-paint.js marks the root element with what this device keeps, which the
 * `in-data-*` classes follow. `window="desktop"` shows the title strip, `sidebar="open"` the
 * expanded sidebar, and `frame="plain"` leaves the sidebar out on setup, Welcome and pairing.
 */
export function AppFrame() {
  return (
    <div aria-busy="true" className={windowFrame}>
      <header className={cn(titleStrip, "hidden in-data-[window=desktop]:flex")}>Hobbots</header>
      <div className={windowBody}>
        <div aria-hidden="true" className={cn(sidebarColumn, "in-data-[frame=plain]:hidden")}>
          <div
            className={cn(
              sidebarNav,
              "in-data-[sidebar=open]:w-sidebar-open max-wide:in-data-[sidebar=open]:shadow-sheet",
            )}
          >
            <div className={sidebarChief}>
              <span className={sidebarIcon}>
                <Skeleton shape="tile" className="size-10" />
              </span>
              <FrameLabel width="9ch" />
            </div>
            {SECTION_WIDTHS.map((width, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list that never reorders.
              <div key={index} className={sidebarItem}>
                <span className={sidebarIcon}>
                  <Skeleton shape="dot" className="size-5" />
                </span>
                <FrameLabel width={width} />
              </div>
            ))}
            <div className={sidebarDivider} />
            <div className={sidebarItem}>
              <span className={sidebarIcon}>
                <Skeleton shape="tile" className="size-hob-tile" />
              </span>
              <FrameLabel width="10ch" />
            </div>
            <div className={cn(sidebarItem, "mt-auto")}>
              <span className={sidebarIcon}>
                <Skeleton shape="dot" className="size-[18px]" />
              </span>
              <FrameLabel width="7ch" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A row's label, which shows only while the sidebar is expanded. */
function FrameLabel({ width }: { width: string }) {
  return <Skeleton width={width} className="hidden in-data-[sidebar=open]:inline-flex" />;
}
