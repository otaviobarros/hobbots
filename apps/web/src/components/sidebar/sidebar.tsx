import { type Agent, OWNER_USER_ID, type User } from "@hobbots/domain";
import { TooltipProvider } from "@hobbots/ui/components/tooltip";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useThreadReplies } from "../../api/hub-status.ts";
import { isMac } from "../archive/archive-rules.ts";
import { MakeCampSheet } from "../camps/make-camp-sheet.tsx";
import { ChiefMark, type ChiefMood } from "../chief/chief-mark.tsx";
import { chiefLabel, chiefMood } from "../chief/chief-mood.ts";
import { messages as inboxCopy } from "../inbox/messages.ts";
import { useWaitingCount } from "../inbox/use-waiting-count.ts";
import { openJump } from "../shell/hob-jump.tsx";
import { messages as copy } from "./messages.ts";
import { SidebarCamps } from "./sidebar-camps.tsx";
import { sidebarColumn, sidebarIcon, sidebarNav, sidebarTop } from "./sidebar-classes.ts";
import { useSidebarData } from "./sidebar-data.ts";
import { PersonBadge } from "./sidebar-faces.tsx";
import { SidebarHobs } from "./sidebar-hobs.tsx";
import { SectionIcon, SidebarNavLink, SidebarTip } from "./sidebar-item.tsx";
import { useWide } from "./use-wide.ts";

/** The four places above the camps. For you opens the Inbox until its own screen replaces it (#1470). */
const NAV = [
  { label: "Home", icon: "Home", to: "/" },
  { label: "For you", icon: "Inbox", to: "/inbox" },
  { label: "Usage", icon: "Usage", to: "/usage" },
  { label: "Settings", icon: "Settings", to: "/settings" },
] as const;

/** In development, `?chief=needs-you`, `?chief=working` or `?chief=idle` previews a mood. */
const previewMood = (): ChiefMood | null => {
  if (!import.meta.env.DEV) return null;
  const mood = new URLSearchParams(window.location.search).get("chief");
  return mood === "idle" || mood === "working" || mood === "needs-you" ? mood : null;
};

/** The hob whose page, chat or camp is open, read from the address. */
const openHobOf = (pathname: string): string | undefined => /^\/hobs\/([^/]+)/.exec(pathname)?.[1];

/**
 * The one navigation column, on every screen after setup (ADR 039, The sidebar; Design System ›
 * Sidebar): the chief, Find or jump to, Home, For you, Usage and Settings, then Camps and Direct
 * messages, which alone scroll, and you at the bottom. 276px wide from the wide breakpoint; below it
 * the same order as a 76px rail of icons, each named by a tooltip.
 */
export function Sidebar() {
  const wide = useWide();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const waiting = useWaitingCount();
  const data = useSidebarData();
  const [making, setMaking] = useState<Agent | null>(null);
  const forCamp = data.hobs.find((hob) => hob.id === openHobOf(pathname)) ?? data.hobs[0];
  const make = forCamp === undefined ? undefined : () => setMaking(forCamp);

  return (
    <TooltipProvider delayDuration={300}>
      <div className={sidebarColumn}>
        <nav aria-label={copy.label} className={sidebarNav}>
          <div className={sidebarTop}>
            <Chief waiting={waiting} />
            <span aria-hidden className="flex-1 font-heading text-reading font-semibold max-wide:hidden">
              {copy.wordmark}
            </span>
            {make !== undefined && (
              <button
                type="button"
                aria-label={copy.makeCamp}
                title={copy.makeCamp}
                onClick={make}
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-secondary hover:bg-hover hover:text-text-strong max-wide:hidden"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10.5 3 13 5.5 7 11.5H4.5V9z" />
                  <path d="M3 14h10" />
                </svg>
              </button>
            )}
          </div>
          <FindButton wide={wide} />
          <div className="flex w-full flex-none gap-0.5 px-2.5 pb-1.5 max-wide:flex-col max-wide:items-center max-wide:px-0">
            {NAV.map((item) => {
              const count = item.label === "For you" && !isActive(item.to) ? waiting : 0;
              return (
                <SidebarNavLink
                  key={item.label}
                  label={item.label}
                  name={count > 0 ? inboxCopy.forYou({ count }) : item.label}
                  icon={item.icon}
                  to={item.to}
                  active={isActive(item.to)}
                  wide={wide}
                  count={count}
                />
              );
            })}
          </div>
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-3 max-wide:px-0">
            <SidebarCamps data={data} pathname={pathname} wide={wide} onMake={make} />
            <SidebarHobs data={data} pathname={pathname} wide={wide} />
          </div>
          {data.read !== undefined && <You you={data.read.you} wide={wide} />}
        </nav>
      </div>
      {making !== null && <MakeCampSheet hob={making} onClose={() => setMaking(null)} />}
    </TooltipProvider>
  );
}

/** Find or jump to: a search field's look that opens the finder, or a magnifier on the rail. */
function FindButton({ wide }: { wide: boolean }) {
  return (
    <SidebarTip label={copy.find} wide={wide}>
      <button
        type="button"
        aria-label={copy.find}
        onClick={openJump}
        className="mx-3 mb-2 flex h-[34px] flex-none cursor-pointer items-center gap-2 self-stretch rounded-control border-(length:--edge) border-line-2 bg-deep px-2.5 text-start text-ui text-label hover:border-control max-wide:mx-auto max-wide:mb-0 max-wide:h-11 max-wide:w-12 max-wide:justify-center max-wide:self-center max-wide:border-0 max-wide:bg-transparent max-wide:px-0 max-wide:hover:bg-hover"
      >
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="size-[15px] flex-none"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        <span aria-hidden className="flex-1 max-wide:hidden">
          {copy.find}
        </span>
        <kbd
          aria-hidden
          className="rounded-[4px] px-[5px] text-meta font-semibold text-label shadow-[inset_0_0_0_1px_var(--color-line-2)] max-wide:hidden"
        >
          {copy.findKeys({ mac: isMac() })}
        </kbd>
      </button>
    </SidebarTip>
  );
}

/** You, at the foot: your badge and name, and the Settings gear. */
function You({ you, wide }: { you: User; wide: boolean }) {
  return (
    <div className="flex w-full flex-none items-center gap-2.5 border-t border-line px-3 pt-2 pb-3 max-wide:justify-center max-wide:px-0">
      <SidebarTip label={you.name} wide={wide}>
        <span role="img" aria-label={you.name} className="inline-flex">
          <PersonBadge person={you} size="md" />
        </span>
      </SidebarTip>
      <span className="flex min-w-0 flex-1 flex-col max-wide:hidden">
        <b className="truncate text-ui font-semibold">{you.name}</b>
        {you.id === OWNER_USER_ID && <small className="text-meta text-label">{copy.youRole}</small>}
      </span>
      <Link to="/settings" aria-label={copy.settings} className={cn(sidebarIcon, "size-[30px] max-wide:hidden")}>
        <SectionIcon name="Settings" />
      </Link>
    </div>
  );
}

/** The chief of the hobs, whose lantern speaks for them: it leads to For you while anything needs you. */
function Chief({ waiting }: { waiting: number }) {
  const [looks, setLooks] = useState(0);
  const activity = useThreadReplies();
  const mood = chiefMood({ waiting, working: Object.keys(activity).length > 0, preview: previewMood() });

  return (
    <Link
      to={mood === "needs-you" ? "/inbox" : "/"}
      aria-label={chiefLabel(mood, waiting)}
      className="inline-flex flex-none no-underline"
      onMouseEnter={() => setLooks((n) => n + 1)}
    >
      <ChiefMark size={32} mood={mood} looks={looks} />
    </Link>
  );
}
