import { cn } from "@hobbots/ui/lib/utils";
import type { ReactElement, ReactNode } from "react";

/**
 * A camp's or a direct message's row. The link holds only the row's name, so what it is called is
 * what it says (WCAG 2.5.3), and it stretches over the whole row; the time, the last line and the
 * counts sit beside it and let clicks through. On the rail only the face shows.
 */
export function SidebarRowFrame({
  face,
  link,
  line,
  aside,
  tall,
}: {
  face: ReactNode;
  /** The row's link; `sidebarRowLink` lays it out. */
  link: ReactElement;
  /** The last line, under the name. */
  line?: ReactNode;
  /** The time, a tag or the counts, at the end of the row. */
  aside?: ReactNode;
  /** A two-line row; a camp a hob runs alone is one line. */
  tall: boolean;
}) {
  return (
    <div
      className={cn(
        "relative grid w-full flex-none grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-control px-2 text-start text-text-strong hover:bg-hover has-[[aria-current=page]]:bg-selected max-wide:flex max-wide:h-11 max-wide:min-h-0 max-wide:w-12 max-wide:justify-center max-wide:p-0",
        tall ? "min-h-12 py-1.5" : "min-h-[34px] py-[3px]",
      )}
    >
      <span
        aria-hidden
        className="relative row-span-2 inline-flex size-hob-tile items-center justify-center max-wide:size-7.5"
      >
        {face}
      </span>
      {link}
      {line !== undefined && (
        <span className="pointer-events-none col-start-2 row-start-2 min-w-0 truncate text-detail max-wide:hidden">
          {line}
        </span>
      )}
      {aside !== undefined && (
        <span className="pointer-events-none col-start-3 row-span-2 row-start-1 flex flex-col items-end gap-0.5 max-wide:hidden">
          {aside}
        </span>
      )}
    </div>
  );
}

/** The row's link: its name in the row's second column, its hit area the whole row. */
export const sidebarRowLink =
  "col-start-2 row-start-1 min-w-0 truncate text-ui text-text-strong no-underline after:absolute after:inset-0 after:rounded-control focus-visible:outline-none focus-visible:after:outline-(--focus-outline) focus-visible:after:-outline-offset-2 max-wide:absolute max-wide:inset-0";
