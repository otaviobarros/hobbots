import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hobbots/ui/components/tooltip";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { ICONS, LINE_ICONS, type SectionName } from "../../art/icons.ts";
import { messages as inboxCopy } from "../inbox/messages.ts";

/** A sidebar row: a 48px icon column, then the label once the sidebar is expanded. */
export const sidebarItem =
  "relative flex min-h-row-min w-full flex-none items-center gap-2 rounded-control py-0.5 text-start text-body text-text-strong no-underline transition-colors duration-150 hover:bg-hover hover:text-text-strong focus-visible:-outline-offset-2 aria-[current=page]:bg-selected";

/** The icon column every row lines up on, so collapsed rows keep their place when it expands. */
export const sidebarIcon = "inline-flex no-underline w-12 flex-none items-center justify-center";

/** While the sidebar is collapsed, hovering or focusing a row names it beside the sidebar. */
export function SidebarTip({
  label,
  expanded,
  children,
}: {
  label: string;
  expanded: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip open={expanded ? false : undefined}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** A section link; `badge` counts what waits there, such as the Inbox's requests that need you. */
export function SidebarLink({
  label,
  to,
  active,
  expanded,
  badge = 0,
}: {
  label: SectionName;
  to: string;
  active: boolean;
  expanded: boolean;
  badge?: number;
}) {
  return (
    <SidebarTip label={label} expanded={expanded}>
      <Link
        to={to}
        aria-current={active ? "page" : undefined}
        aria-label={badge > 0 ? inboxCopy.sidebar({ count: badge }) : undefined}
        className={sidebarItem}
      >
        <span className={cn(sidebarIcon, active ? "text-text-strong" : "text-text-secondary")}>
          <SectionIcon name={label} />
        </span>
        <span className="sidebar-label flex-1">{label}</span>{" "}
        {badge > 0 && (
          <span
            aria-hidden
            className="absolute start-7 top-0 rounded-tag bg-lantern px-[5px] text-meta font-bold text-on-lantern group-data-[open=true]/side:static group-data-[open=true]/side:me-2"
          >
            {inboxCopy.count({ count: badge })}
          </span>
        )}
      </Link>
    </SidebarTip>
  );
}

/** Pixel art keeps its accent; the main color follows the row's text, so it dims when inactive. */
const PIXEL_PALETTE = { "#": "currentColor", o: "var(--color-control)" };

/** A section's icon: the skin shows the line icon in Lamplight and the pixel icon in Workshop. */
function SectionIcon({ name }: { name: SectionName }) {
  return (
    <>
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="line-icon size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={LINE_ICONS[name]} />
      </svg>
      <PixelArt rows={ICONS[name]} palette={PIXEL_PALETTE} size={24} className="pixel-icon" />
    </>
  );
}
