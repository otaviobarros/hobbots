import type { Agent } from "@hobbots/domain";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** The Archive's page frame: a centered column that scrolls inside the shell. */
export function ArchiveFrame({ label, wide = true, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <main aria-label={label} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div
        className={`mx-auto flex w-full flex-1 flex-col gap-5 px-6 pt-5 pb-12 ${wide ? "max-w-[920px]" : "max-w-[800px]"}`}
      >
        {children}
      </div>
    </main>
  );
}

/** One step back in the breadcrumb, before the current page's name. */
export type Crumb = { readonly label: string } & (
  | { readonly to: "/archive"; readonly search: { tab?: "hobs"; hob?: string } }
  | { readonly to: "/archive/hobs/$hobId"; readonly params: { hobId: string } }
);

/** Your hobs, then the steps given, then the current page. */
export function Crumbs({ trail, current }: { trail: ReadonlyArray<Crumb>; current: string }) {
  return (
    <nav aria-label={copy.crumbs} className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
      <Link to="/hobs" className={crumbLink}>
        {copy.yourHobs}
      </Link>
      {trail.map((crumb) => (
        <span key={crumb.label} className="flex flex-none items-center gap-2">
          <Separator />
          {crumb.to === "/archive" ? (
            <Link to="/archive" search={crumb.search} className={crumbLink}>
              {crumb.label}
            </Link>
          ) : (
            <Link to="/archive/hobs/$hobId" params={crumb.params} className={crumbLink}>
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
      <Separator />
      <span aria-current="page" title={current} className="min-w-0 truncate text-text-strong">
        {current}
      </span>
    </nav>
  );
}

const crumbLink = "flex-none text-text-secondary no-underline hover:text-text-strong hover:underline";

function Separator() {
  return (
    <span aria-hidden className="text-label">
      /
    </span>
  );
}

/** A hob's portrait on a sunken tile, grayed: it is not where the hob is working now. */
export function DimPortrait({ hob, size = "row" }: { hob: Agent; size?: "row" | "header" }) {
  return (
    <span
      aria-hidden
      className={`grid flex-none place-items-center rounded-control bg-deep ${size === "row" ? "size-9" : "size-12"}`}
    >
      <HobSprite hob={hob} size={size === "row" ? 28 : 38} className="opacity-60 grayscale-80" />
    </span>
  );
}

// Retired hobs go gray: the door takes the control color where an active hob takes its hat color.
export const doorStyle = {
  "--hob": "var(--color-control)",
  backgroundImage:
    "linear-gradient(180deg, color-mix(in srgb, var(--hob) 26%, var(--color-card)) 0%, var(--color-card) 100%)",
} as CSSProperties;

export const stripStyle: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(90deg, color-mix(in srgb, var(--hob) 50%, var(--color-deep)) 0 8px, color-mix(in srgb, var(--hob) 35%, var(--color-deep)) 8px 16px)",
};

function LineIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4 flex-none"
    >
      {children}
    </svg>
  );
}

/** The arrow that turns back, on Restore and Bring back. */
export function RestoreIcon() {
  return (
    <LineIcon>
      <path d="M5 3 2.5 5.5 5 8" />
      <path d="M2.5 5.5H10a3.5 3.5 0 0 1 0 7H6" />
    </LineIcon>
  );
}

/** The moon on everything retired. */
export function MoonIcon() {
  return (
    <LineIcon>
      <path d="M12.5 10A5.5 5.5 0 0 1 6 3.5a5.5 5.5 0 1 0 6.5 6.5z" />
    </LineIcon>
  );
}

/** A closed box, on the note in an archived chat. */
export function BoxIcon() {
  return (
    <LineIcon>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v7h10V6M6.5 9h3" />
    </LineIcon>
  );
}

/** A lock, for what is read-only. */
export function LockIcon({ label }: { label?: string }) {
  const icon = (
    <LineIcon>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </LineIcon>
  );
  return label ? (
    <span role="img" aria-label={label} className="flex">
      {icon}
    </span>
  ) : (
    icon
  );
}

/** A quiet note at the top of a read-only page. */
export function ArchiveNote({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-card bg-notice px-3.5 py-3 text-sm leading-5 text-text [&>svg]:mt-0.5 [&>svg]:text-label"
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
