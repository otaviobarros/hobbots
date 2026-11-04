import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { iconPalette } from "../../art/icons.ts";
import { messages } from "../messages.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";

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

/** A choice card's frame; `choiceOpenClass` adds the hover and focus of one that can be chosen. */
const choiceClass = "flex items-start gap-4 rounded-card bg-card p-5 text-left text-text-strong no-underline";
export const choiceOpenClass = `${choiceClass} cursor-pointer border-0 transition-colors hover:bg-hover hover:shadow-[inset_0_0_0_2px_var(--color-moonlight)] focus-visible:outline-3 focus-visible:outline-moonlight focus-visible:-outline-offset-3 disabled:cursor-wait`;

function ChoiceIcon({ rows, palette }: { rows: ReadonlyArray<string>; palette: Record<string, string> }) {
  return (
    <span className="flex size-12 flex-none items-center justify-center">
      <PixelArt rows={rows} palette={palette} size={44} />
    </span>
  );
}

/** A choice's title with its tag beside it, and what it means under them. */
function ChoiceText({
  title,
  tag,
  body,
  muted = false,
  children,
}: {
  title: string;
  tag?: ReactNode;
  body: string;
  muted?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <strong className={cn("text-[17px]", muted && "text-text-secondary")}>{title}</strong>
        {tag}
      </span>
      <span className="leading-normal text-text-secondary">{body}</span>
      {children}
    </span>
  );
}

/** What "Run Hobbots on this computer" says, inside the card the page gives it; `badge` replaces its tag. */
export function RunHereChoice({ badge = copy.here.badge }: { badge?: string }) {
  return (
    <>
      <ChoiceIcon rows={HOUSE} palette={HOUSE_PALETTE} />
      <ChoiceText
        title={copy.here.title}
        tag={<span className="rounded-tag bg-line-2 px-2 py-0.5 text-detail font-bold">{badge}</span>}
        body={copy.here.body}
      />
    </>
  );
}

/** What "Connect to Hobbots on another computer" says, inside the card the page gives it; `muted` when it cannot be chosen. */
export function ConnectChoice({ muted = false, children }: { muted?: boolean; children?: ReactNode }) {
  return (
    <>
      <ChoiceIcon rows={LINK} palette={LINK_PALETTE} />
      <ChoiceText title={copy.connect.title} body={copy.connect.body} muted={muted}>
        {children}
      </ChoiceText>
    </>
  );
}

/** Where Hobbots runs: the title, the intro and the two choices, with the hub's house in the preview. */
export function WhereLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <OnboardingFrame step={null} preview={{ house: true, caption: copy.caption, speech: copy.speech }} footer={null}>
      <div className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.title}</h1>
          <p className="m-0 text-text-secondary">{copy.intro}</p>
        </div>
        <div className="flex flex-col gap-2.5">{children}</div>
        {footer}
      </div>
    </OnboardingFrame>
  );
}

/**
 * Where Hobbots runs on the hub's own pages, the first step of setup once this computer is the hub.
 * Running here leads to Your AI. A hub does not become a connected desktop
 * (ADR 025), so Connect only says where to choose it: in the app on the other computer.
 */
export function WhereHobbotsRuns() {
  return (
    <WhereLayout>
      <Link to="/setup/providers" className={choiceOpenClass}>
        <RunHereChoice />
      </Link>
      <div className={choiceClass}>
        <ConnectChoice muted>
          <span className="pt-1 text-detail leading-normal text-label">{copy.connect.onHub}</span>
        </ConnectChoice>
      </div>
    </WhereLayout>
  );
}
