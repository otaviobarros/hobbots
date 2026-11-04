import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { ICONS, type IconName, iconPalette, LINE_ICONS } from "../../art/icons.ts";

/**
 * A section's page: its header, then its content, in one centred column, so the header's `actions`,
 * such as a period picker, line up with the content under them.
 */
export function Page({
  icon,
  title,
  intro,
  actions,
  children,
}: {
  icon: IconName;
  title: string;
  intro: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto px-9 py-8">
      <div className="mx-auto flex w-full max-w-home-max flex-col gap-7">
        <PageHeader icon={icon} title={title} intro={intro} actions={actions} />
        {children}
      </div>
    </main>
  );
}

/** A page header's icon: the section's line icon on a mint tile, or its pixel icon when it has no line icon. */
function PageIcon({ icon }: { icon: IconName }) {
  const line = icon in LINE_ICONS ? LINE_ICONS[icon as keyof typeof LINE_ICONS] : undefined;
  if (line === undefined) return <PixelArt rows={ICONS[icon]} palette={iconPalette(true)} size={40} />;
  return (
    <span
      aria-hidden
      className="grid size-[38px] shrink-0 place-items-center rounded-tile bg-[color-mix(in_srgb,var(--color-mint)_16%,transparent)] text-mint"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        width={18}
        height={18}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={line} />
      </svg>
    </span>
  );
}

/**
 * A section's header: its icon, title and one line under it, with `actions` at the end of the row.
 * `bar` is the compact header that spans a page split into columns, such as the Inbox, with a rule
 * under it; `introClassName` colors the line, such as lantern when something expires soon.
 */
export function PageHeader({
  icon,
  title,
  intro,
  actions,
  size = "page",
  introClassName,
}: {
  icon: IconName;
  title: string;
  intro: string;
  actions?: ReactNode;
  size?: "page" | "bar";
  introClassName?: string | undefined;
}) {
  const bar = size === "bar";
  return (
    <header
      className={cn(
        "flex flex-wrap items-center",
        bar ? "flex-none gap-3.5 border-b border-line px-6 py-3.5" : "gap-3.5",
      )}
    >
      {bar ? (
        <span aria-hidden className="grid size-9.5 flex-none place-items-center rounded-tile bg-lantern/15">
          <PixelArt rows={ICONS[icon]} palette={iconPalette(true)} size={24} />
        </span>
      ) : (
        <PageIcon icon={icon} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h1 className={cn("m-0 font-heading text-heading font-bold", bar ? "text-text-strong" : "text-moonlight")}>
          {title}
        </h1>
        <p className={cn("m-0", bar && "text-detail", introClassName ?? "text-text-secondary")}>{intro}</p>
      </div>
      {actions !== undefined && <div className="flex flex-none items-center gap-2">{actions}</div>}
    </header>
  );
}
