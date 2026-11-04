import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ICONS, type IconName, iconPalette } from "../art/icons.ts";
import { ArchivedHobs } from "./archived-hobs.tsx";

export function Page({
  icon,
  title,
  intro,
  children,
}: {
  icon: IconName;
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-9 py-8">
      <header className="flex items-center gap-3.5">
        <PixelArt rows={ICONS[icon]} palette={iconPalette(true)} size={40} />
        <div className="flex flex-col gap-0.5">
          <h1 className="m-0 font-heading text-[28px] font-bold text-moonlight">{title}</h1>
          <p className="m-0 text-text-secondary">{intro}</p>
        </div>
      </header>
      {children}
    </main>
  );
}

function Panel({
  label,
  id,
  children,
  className,
}: {
  label: string;
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className={cn("cut flex max-w-[760px] flex-col gap-3 bg-panel px-[18px] py-4", className)}
    >
      <span className="lbl text-moonlight">{label}</span>
      {children}
    </section>
  );
}

/** Settings › Archived hobs on its own, where a retired hob's profile and its chats lead back to. */
export function ArchivedHobsPage() {
  return (
    <Page icon="Settings" title="Archived hobs" intro="Retired hobs and the chats they leave behind.">
      <Link
        to="/settings/$section"
        params={{ section: "data" }}
        className="text-sm text-lantern no-underline hover:underline"
      >
        ‹ All settings
      </Link>
      <Panel label="Archived hobs">
        <ArchivedHobs />
      </Panel>
    </Page>
  );
}
