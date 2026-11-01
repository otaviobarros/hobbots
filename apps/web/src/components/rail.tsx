import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useActivity } from "../api/activity.ts";
import { ICONS, type IconName, iconPalette } from "../art/icons.ts";
import { ChiefMark, type ChiefMood } from "./chief-mark.tsx";
import { messages as inboxCopy } from "./inbox/messages.ts";
import { useWaitingCount } from "./inbox/use-waiting-count.ts";

// The MVP rail from the Hobbots design. Routines and Memory return after the MVP.
const ITEMS = [
  { label: "Home", to: "/" },
  { label: "Hobs", to: "/hobs" },
  { label: "Inbox", to: "/inbox" },
  { label: "Usage", to: "/usage" },
] as const satisfies ReadonlyArray<{ label: IconName; to: string }>;

/**
 * Requests waiting for you in the Inbox. The Inbox has no requests in this build, so this is 0
 * until it does (#43); in development, `?chief=needs-you` or `?chief=working` previews a mood.
 */
const useNeedsYou = (): number => 0;

const previewMood = (): ChiefMood | null => {
  if (!import.meta.env.DEV) return null;
  const mood = new URLSearchParams(window.location.search).get("chief");
  return mood === "idle" || mood === "working" || mood === "needs-you" ? mood : null;
};

export function Rail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const [looks, setLooks] = useState(0);
  const activity = useActivity();
  const needsYou = useNeedsYou();
  const waiting = useWaitingCount();
  const mood: ChiefMood =
    previewMood() ?? (needsYou > 0 ? "needs-you" : Object.keys(activity).length > 0 ? "working" : "idle");
  const label =
    mood === "needs-you"
      ? `Hobbots inbox, ${needsYou > 1 ? `${needsYou} requests need` : "a request needs"} you`
      : mood === "working"
        ? "Hobbots home, hobs are working"
        : "Hobbots home";

  return (
    <nav
      aria-label="Sections"
      className="flex w-[76px] flex-none flex-col items-center gap-2 border-r-4 border-line bg-deep py-3.5"
    >
      <Link
        to={mood === "needs-you" ? "/inbox" : "/"}
        aria-label={label}
        className="pb-2"
        onMouseEnter={() => setLooks((n) => n + 1)}
      >
        <ChiefMark size={40} mood={mood} looks={looks} />
      </Link>
      {ITEMS.map((item) => (
        <RailLink
          key={item.label}
          label={item.label}
          to={item.to}
          active={isActive(item.to)}
          badge={item.label === "Inbox" && !isActive(item.to) ? waiting : 0}
        />
      ))}
      <RailLink label="Settings" to="/settings" active={isActive("/settings")} className="mt-auto" />
    </nav>
  );
}

/** A section link; `badge` counts what waits there, such as the Inbox's requests that need you. */
function RailLink({
  label,
  to,
  active,
  badge = 0,
  className,
}: {
  label: IconName;
  to: string;
  active: boolean;
  badge?: number;
  className?: string;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      aria-label={badge > 0 ? inboxCopy.rail({ count: badge }) : undefined}
      className={cn(
        "cut relative flex w-[62px] flex-col items-center gap-[5px] pt-2 pb-[7px] text-xs no-underline",
        active ? "bg-line text-moonlight hover:text-moonlight" : "text-label hover:bg-hover hover:text-text",
        className,
      )}
    >
      <PixelArt rows={ICONS[label]} palette={iconPalette(active)} size={24} />
      {label}
      {badge > 0 && (
        <span
          aria-hidden
          className="absolute end-2 top-1 flex h-4 min-w-4 items-center justify-center bg-lantern px-0.5 text-xs font-bold text-ground"
        >
          {inboxCopy.count({ count: badge })}
        </span>
      )}
    </Link>
  );
}
