import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { ICONS, type IconName, iconPalette } from "../art/icons.ts";

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
