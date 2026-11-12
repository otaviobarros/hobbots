import { TooltipProvider } from "@hobbots/ui/components/tooltip";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useThreadReplies } from "../../api/hub-status.ts";
import type { SectionName } from "../../art/icons.ts";
import { ChiefMark, type ChiefMood } from "../chief/chief-mark.tsx";
import { chiefLabel, chiefMood } from "../chief/chief-mood.ts";
import { useWaitingCount } from "../inbox/use-waiting-count.ts";
import { messages } from "./messages.ts";
import { sidebarChief, sidebarColumn, sidebarIcon, sidebarItem, sidebarNav } from "./sidebar-classes.ts";
import { SidebarHobs } from "./sidebar-hobs.tsx";
import { SidebarLink, SidebarTip } from "./sidebar-item.tsx";
import { useSidebarOpen } from "./use-sidebar-open.ts";

const copy = messages;

// The six sections; the hobs follow them. Routines return after the MVP. Only the Inbox carries a
// badge: Memory and Skills never do, since nothing there waits on you that the Inbox does not count.
const ITEMS = [
  { label: "Home", to: "/" },
  { label: "Inbox", to: "/inbox" },
  { label: "Memory", to: "/memory" },
  { label: "Skills", to: "/skills" },
  { label: "Usage", to: "/usage" },
  { label: "Settings", to: "/settings" },
] as const satisfies ReadonlyArray<{ label: SectionName; to: string }>;

/** In development, `?chief=needs-you`, `?chief=working` or `?chief=idle` previews a mood. */
const previewMood = (): ChiefMood | null => {
  if (!import.meta.env.DEV) return null;
  const mood = new URLSearchParams(window.location.search).get("chief");
  return mood === "idle" || mood === "working" || mood === "needs-you" ? mood : null;
};

/**
 * The one navigation column, on every screen after setup. It collapses to 72px but never hides;
 * expanded it is 256px. From 1100px wide it pushes the page aside; below that it stays 72px in place
 * and, expanded, opens over the page, which keeps its width. Only the hob list scrolls, so the chief,
 * the sections and the chevron stay on screen however many hobs there are.
 */
export function Sidebar() {
  const [open, toggle] = useSidebarOpen();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  // The Inbox's pending requests, kept live by the event stream, light the chief's lantern and
  // count on the Inbox's link, unless the Inbox is already open.
  const waiting = useWaitingCount();

  return (
    <TooltipProvider delayDuration={300}>
      <div className={sidebarColumn}>
        <nav aria-label={copy.label} data-open={open} className={sidebarNav}>
          <Chief waiting={waiting} />
          {ITEMS.map((item) => (
            <SidebarLink
              key={item.label}
              label={item.label}
              to={item.to}
              active={isActive(item.to)}
              expanded={open}
              badge={item.label === "Inbox" && !isActive(item.to) ? waiting : 0}
            />
          ))}
          <SidebarHobs expanded={open} />
          <SidebarTip label={copy.expand} expanded={open}>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              aria-label={open ? copy.collapseLabel : copy.expandLabel}
              className={cn(sidebarItem, "mt-auto cursor-pointer")}
            >
              <span className={cn(sidebarIcon, "text-text-secondary")}>
                <Chevron open={open} />
              </span>
              <span className="sidebar-label text-detail text-text-secondary">{copy.collapse}</span>
            </button>
          </SidebarTip>
        </nav>
      </div>
    </TooltipProvider>
  );
}

/** The chief of the hobs, whose lantern speaks for them: it leads to the Inbox while anything needs you. */
function Chief({ waiting }: { waiting: number }) {
  const [looks, setLooks] = useState(0);
  const activity = useThreadReplies();
  const mood = chiefMood({ waiting, working: Object.keys(activity).length > 0, preview: previewMood() });

  return (
    <div className={sidebarChief}>
      <Link
        to={mood === "needs-you" ? "/inbox" : "/"}
        aria-label={chiefLabel(mood, waiting)}
        className={sidebarIcon}
        onMouseEnter={() => setLooks((n) => n + 1)}
      >
        <ChiefMark size={40} mood={mood} looks={looks} />
      </Link>
      <span aria-hidden className="sidebar-label font-heading text-reading font-semibold">
        {copy.wordmark}
      </span>
    </div>
  );
}

/** Points the way the sidebar will move: right to expand, left to collapse. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn("size-[18px] transition-transform duration-(--dur-sheet)", open && "rotate-180")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
