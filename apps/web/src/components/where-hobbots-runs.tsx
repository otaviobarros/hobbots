import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ELDER, ELDER_PALETTE, iconPalette } from "../art/icons.ts";
import { messages } from "./messages.ts";
import { Stars } from "./scene.tsx";

const copy = messages.where;

const HOUSE = [
  "....##....",
  "...####...",
  "..######..",
  ".########.",
  "##########",
  ".#oo##oo#.",
  ".#oo##oo#.",
  ".########.",
  ".###..###.",
  ".###..###.",
];
const HOUSE_PALETTE = iconPalette(true);

const LINK = [
  "..........",
  ".####.....",
  ".#..#.....",
  ".#..#.....",
  ".####o....",
  ".....o####",
  ".....#..#.",
  ".....#..#.",
  ".....####.",
  "..........",
];
const LINK_PALETTE = HOUSE_PALETTE;

const FIREFLIES = [0, 1, 2, 3, 4, 5].map((i) => ({ x: 30 + i * 64, bottom: 206 - (i % 3) * 30, delay: i * 0.7 }));

/** A choice card's frame; `choiceOpenClass` adds the hover and focus of one that can be chosen. */
const choiceClass = "cut flex flex-col gap-3 border-2 bg-card p-[22px] text-left text-text-strong no-underline";
export const choiceOpenClass = `${choiceClass} cursor-pointer border-line-2 transition-transform duration-100 ease-(--ease-press) hover:-translate-y-[3px] hover:border-moonlight focus-visible:outline-3 focus-visible:outline-moonlight focus-visible:-outline-offset-3 disabled:cursor-wait disabled:hover:translate-y-0`;

function ChoiceIcon({ rows, palette }: { rows: ReadonlyArray<string>; palette: Record<string, string> }) {
  return (
    <span className="cut flex size-14 items-center justify-center bg-line">
      <PixelArt rows={rows} palette={palette} size={40} />
    </span>
  );
}

/** What "Run Hobbots on this computer" says, inside the card the page gives it; `badge` replaces its tag. */
export function RunHereChoice({ badge = copy.here.badge }: { badge?: string }) {
  return (
    <>
      <ChoiceIcon rows={HOUSE} palette={HOUSE_PALETTE} />
      <span className="font-heading text-2xl font-bold text-moonlight">{copy.here.title}</span>
      <span className="text-text-secondary leading-normal">{copy.here.body}</span>
      <span className="self-start bg-moonlight px-2 py-0.5 text-[13px] font-bold text-ground">{badge}</span>
    </>
  );
}

/** What "Connect to Hobbots on another computer" says, inside the card the page gives it; `muted` when it cannot be chosen. */
export function ConnectChoice({ muted = false, children }: { muted?: boolean; children?: ReactNode }) {
  return (
    <>
      <ChoiceIcon rows={LINK} palette={LINK_PALETTE} />
      <span className={`font-heading text-2xl font-bold ${muted ? "text-label" : "text-moonlight"}`}>
        {copy.connect.title}
      </span>
      <span className="text-text-secondary leading-normal">{copy.connect.body}</span>
      {children}
    </>
  );
}

/** Where Hobbots runs: the title, the intro and the two choices, beside the Elder Hob. */
export function WhereLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <ElderAside stage={copy.stage} speech={copy.speech} />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-12 pt-10 pb-6">
        <div className="flex animate-hb-in flex-col gap-2">
          <h1 className="m-0 font-heading text-[32px] font-bold text-moonlight">{copy.title}</h1>
          <p className="m-0 mb-[22px] max-w-[640px] text-text-secondary">{copy.intro}</p>
          <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">{children}</div>
          {footer}
        </div>
      </main>
    </div>
  );
}

/** The Elder Hob's side of the setup steps that come before onboarding: the night scene and what it says. */
export function ElderAside({ stage, speech }: { stage: string; speech: string }) {
  // Each poke replays the Elder Hob's hop.
  const [hops, setHops] = useState(0);
  return (
    <aside className="relative w-[420px] flex-none overflow-hidden border-line border-r-4 bg-panel max-md:hidden">
      <Stars count={22} height={260} />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-[150px] bg-scene-ground" />
      <div aria-hidden className="absolute inset-x-0 bottom-[150px] h-2 bg-line" />
      <div className="absolute top-7 left-7 flex items-center gap-2.5">
        <span className="font-pixel text-[22px] font-bold text-moonlight">Hobbots</span>
        <span className="text-[13px] text-label">{stage}</span>
      </div>
      <div className="cut absolute inset-x-7 top-[84px] min-h-[150px] bg-text-strong px-5 py-[18px] text-[17px] text-ground leading-normal">
        <span className="lbl mb-1.5 block text-ground/70 text-[13px]">{copy.elder}</span>
        <span key={speech} aria-live="polite" className="block animate-hb-in">
          {speech}
        </span>
      </div>
      <div
        aria-hidden
        className="absolute top-[232px] left-[150px] border-x-[14px] border-x-transparent border-t-[16px] border-t-text-strong"
      />
      {FIREFLIES.map((f) => (
        <span
          key={f.x}
          aria-hidden
          className="absolute size-1 animate-hb-float bg-lantern [animation-duration:4s]"
          style={{ left: f.x, bottom: f.bottom, animationDelay: `${f.delay}s` }}
        />
      ))}
      <button
        type="button"
        aria-label={copy.elder}
        onClick={() => setHops((n) => n + 1)}
        className="absolute bottom-[150px] left-[106px] cursor-pointer border-0 bg-transparent p-0"
      >
        <span className="block animate-hb-bob">
          <span key={hops} className={`block ${hops > 0 ? "animate-(--hop)" : ""}`}>
            <PixelArt rows={ELDER} palette={ELDER_PALETTE} size={120} />
          </span>
        </span>
      </button>
      <div aria-hidden className="absolute bottom-[150px] left-[238px] h-28 w-2 bg-wood" />
      <div
        aria-hidden
        className="absolute bottom-[256px] left-[230px] h-[22px] w-6 animate-hb-flicker bg-lantern shadow-[0_0_22px_6px_color-mix(in_srgb,var(--color-lantern)_45%,transparent)]"
      />
    </aside>
  );
}

/**
 * Where Hobbots runs on the hub's own pages, the first step of setup once this computer is the hub.
 * Running here leads to the optional remote access step. A hub does not become a connected desktop
 * (ADR 025), so Connect only says where to choose it: in the app on the other computer.
 */
export function WhereHobbotsRuns() {
  return (
    <WhereLayout>
      <Link to="/setup/remote" className={choiceOpenClass}>
        <RunHereChoice />
      </Link>
      <div className={`${choiceClass} border-line opacity-70`}>
        <ConnectChoice muted>
          <span className="self-start border-2 border-control px-2 py-0.5 text-[13px] leading-normal">
            {copy.connect.onHub}
          </span>
        </ConnectChoice>
      </div>
    </WhereLayout>
  );
}
