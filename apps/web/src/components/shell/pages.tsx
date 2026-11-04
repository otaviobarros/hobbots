import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { ICONS, type IconName, iconPalette } from "../../art/icons.ts";

/**
 * A section's page: its header, then its content. `actions` sit at the end of the title row, such
 * as a period picker; they wrap below the title when the page is narrow.
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
    <main className="relative flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-9 py-8">
      <PageHeader icon={icon} title={title} intro={intro} actions={actions} />
      {children}
    </main>
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
        <PixelArt rows={ICONS[icon]} palette={iconPalette(true)} size={40} />
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
