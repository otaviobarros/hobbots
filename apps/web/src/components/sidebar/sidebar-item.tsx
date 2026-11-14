import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hobbots/ui/components/tooltip";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { ICONS, LINE_ICONS, type SectionName } from "../../art/icons.ts";
import { formatCount } from "../../lib/format.ts";
import { messages as copy } from "./messages.ts";

/** On the narrow rail, hovering or focusing a row names it beside the sidebar. */
export function SidebarTip({ label, wide, children }: { label: string; wide: boolean; children: ReactElement }) {
  return (
    <Tooltip open={wide ? false : undefined}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One of the four places above the camps: its icon with its label under it, or the icon alone on the
 * rail. `count` is what waits there, such as For you's, and is read after the label, as in "For you,
 * 2 waiting on you". The badge draws the count from `data-count`, so the words the link shows are the
 * start of its name (WCAG 2.5.3).
 */
export function SidebarNavLink({
  label,
  icon,
  to,
  active,
  wide,
  count = 0,
}: {
  label: string;
  icon: SectionName;
  to: string;
  active: boolean;
  wide: boolean;
  count?: number;
}) {
  return (
    <SidebarTip label={label} wide={wide}>
      <Link
        to={to}
        aria-current={active ? "page" : undefined}
        aria-label={count > 0 ? `${label}${copy.waiting({ count })}` : undefined}
        className="relative inline-flex flex-1 flex-col items-center gap-px rounded-control pt-1.5 pb-1 text-meta text-text-secondary no-underline hover:bg-hover hover:text-text-strong aria-[current=page]:bg-selected aria-[current=page]:font-semibold aria-[current=page]:text-text-strong max-wide:h-11 max-wide:w-12 max-wide:flex-none max-wide:justify-center max-wide:p-0"
      >
        <SectionIcon name={icon} />
        <span className="max-wide:sr-only">{label}</span>
        {count > 0 && (
          <span
            aria-hidden
            data-count={formatCount(count)}
            className="absolute start-[calc(50%+4px)] top-0.5 rounded-tag bg-lantern px-[5px] text-meta font-bold text-on-lantern after:content-[attr(data-count)] max-wide:start-auto max-wide:end-0.5"
          />
        )}
      </Link>
    </SidebarTip>
  );
}

/** Pixel art keeps its accent; the main color follows the row's text, so it dims when inactive. */
const PIXEL_PALETTE = { "#": "currentColor", o: "var(--color-control)" };

/** A section's icon: the skin shows the line icon in Lamplight and the pixel icon in Workshop. */
export function SectionIcon({ name }: { name: SectionName }) {
  return (
    <>
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="line-icon size-[18px] max-wide:size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={LINE_ICONS[name]} />
      </svg>
      <PixelArt rows={ICONS[name]} palette={PIXEL_PALETTE} size={20} className="pixel-icon" />
    </>
  );
}
