import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hobbots/ui/components/tooltip";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { ICONS, type IconName, iconPalette } from "../../art/icons.ts";
import { messages as inboxCopy } from "../inbox/messages.ts";

/** A sidebar row: a 48px icon column, then the label once the sidebar is expanded. */
export const sidebarItem =
  "relative flex min-h-row-min w-full flex-none items-center gap-2 rounded-control py-0.5 text-start text-body text-text-strong no-underline transition-colors duration-150 hover:bg-hover hover:text-text-strong focus-visible:-outline-offset-2 aria-[current=page]:bg-selected";

/** The icon column every row lines up on, so collapsed rows keep their place when it expands. */
export const sidebarIcon = "inline-flex w-12 flex-none items-center justify-center";

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
  label: IconName;
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
        <span className={sidebarIcon}>
          <PixelArt rows={ICONS[label]} palette={iconPalette(active)} size={24} />
        </span>
        <span className="sidebar-label flex-1">{label}</span>
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
