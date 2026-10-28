import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { CREST, CREST_PALETTE, ICONS, type IconName, iconPalette } from "../art/icons.ts";

// The MVP rail from the Hobbots design. Routines and Memory return after the MVP.
const ITEMS = [
  { label: "Home", to: "/" },
  { label: "Hobs", to: "/hobs" },
  { label: "Inbox", to: "/inbox" },
  { label: "Usage", to: "/usage" },
] as const satisfies ReadonlyArray<{ label: IconName; to: string }>;

export function Rail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));

  return (
    <nav
      aria-label="Sections"
      className="flex w-[76px] flex-none flex-col items-center gap-2 border-r-4 border-line bg-deep py-3.5"
    >
      <Link to="/" aria-label="Hobbots home" className="pb-2">
        <PixelArt rows={CREST} palette={CREST_PALETTE} size={34} />
      </Link>
      {ITEMS.map((item) => (
        <RailLink key={item.label} label={item.label} to={item.to} active={isActive(item.to)} />
      ))}
      <RailLink label="Settings" to="/settings" active={isActive("/settings")} className="mt-auto" />
    </nav>
  );
}

function RailLink({
  label,
  to,
  active,
  className,
}: {
  label: IconName;
  to: string;
  active: boolean;
  className?: string;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "cut flex w-[62px] flex-col items-center gap-[5px] pt-2 pb-[7px] text-xs no-underline",
        active ? "bg-line text-moonlight hover:text-moonlight" : "text-label hover:bg-hover hover:text-text",
        className,
      )}
    >
      <PixelArt rows={ICONS[label]} palette={iconPalette(active)} size={24} />
      {label}
    </Link>
  );
}
