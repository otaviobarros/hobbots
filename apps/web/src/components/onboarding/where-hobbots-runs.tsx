import { Button } from "@hobbots/ui/components/button";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { iconPalette } from "../../art/icons.ts";
import { messages } from "../messages.ts";
import { PickCard } from "../summon/pick.tsx";
import { OnboardingFrame } from "./onboarding-frame.tsx";

const copy = messages.where;
const shared = messages.onboarding;

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

/** A choice card: a label over a native radio, so the pair gets arrow keys and its names from the browser. */
function ChoiceCard({
  name,
  checked,
  onPick,
  disabled = false,
  children,
}: {
  name: string;
  checked: boolean;
  onPick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <PickCard
      name={name}
      checked={checked}
      onPick={onPick}
      className={cn("gap-4 rounded-card p-5", disabled && "cursor-wait opacity-85")}
    >
      {children}
    </PickCard>
  );
}

function ChoiceIcon({ rows, palette }: { rows: ReadonlyArray<string>; palette: Record<string, string> }) {
  return (
    <span className="flex size-12 flex-none items-center justify-center">
      <PixelArt rows={rows} palette={palette} size={44} />
    </span>
  );
}

/** A choice's title with its tag beside it, and what it means under them. */
function ChoiceText({ title, tag, body }: { title: string; tag?: ReactNode; body: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <strong className="text-title">{title}</strong>
        {tag}
      </span>
      <span className="leading-normal text-text-secondary">{body}</span>
    </span>
  );
}

/** Which of the two the user picked on Where Hobbots runs. */
export type WherePick = "here" | "other";

/**
 * The two choices as a radio pair: this computer becomes the hub, or another computer already is.
 * `badge` replaces this computer's tag, as while its hub starts.
 */
export function WhereChoices({
  value,
  onPick,
  badge = copy.here.badge,
  disabled = false,
}: {
  value: WherePick;
  onPick: (pick: WherePick) => void;
  badge?: string;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
      <legend className="sr-only">{copy.legend}</legend>
      <ChoiceCard name={name} checked={value === "here"} onPick={() => onPick("here")} disabled={disabled}>
        <ChoiceIcon rows={HOUSE} palette={HOUSE_PALETTE} />
        <ChoiceText
          title={copy.here.title}
          tag={<span className="rounded-tag bg-line-2 px-2 py-0.5 text-detail font-bold">{badge}</span>}
          body={copy.here.body}
        />
      </ChoiceCard>
      <ChoiceCard name={name} checked={value === "other"} onPick={() => onPick("other")} disabled={disabled}>
        <ChoiceIcon rows={LINK} palette={LINK_PALETTE} />
        <ChoiceText title={copy.connect.title} body={copy.connect.body} />
      </ChoiceCard>
    </fieldset>
  );
}

/** Where Hobbots runs: the title, the intro and the two choices, with Back and Continue in the footer. */
export function WhereLayout({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <OnboardingFrame step={null} preview={{ house: true, caption: copy.caption, speech: copy.speech }} footer={footer}>
      <div className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 font-heading text-display font-bold text-moonlight">{copy.title}</h1>
          <p className="m-0 text-text-secondary">{copy.intro}</p>
        </div>
        {children}
      </div>
    </OnboardingFrame>
  );
}

/** Where's footer: Back to Welcome, and Continue with what was picked. */
export function WhereFooter({
  onBack,
  onContinue,
  blocked = false,
  busy = false,
}: {
  onBack: () => void;
  onContinue: () => void;
  /** Continue can't go on with this pick; the note under the choices says why. */
  blocked?: boolean;
  busy?: boolean;
}) {
  return (
    <>
      <span className="flex-1" />
      <Button variant="outline" onClick={onBack} disabled={busy}>
        {shared.back}
      </Button>
      <Button onClick={onContinue} disabled={busy || blocked}>
        {shared.continue}
      </Button>
    </>
  );
}

/**
 * Where Hobbots runs on the hub's own pages, the first step of setup once this computer is the hub.
 * This computer leads to Your AI. A hub does not become a connected desktop (ADR 025), so picking
 * another computer only says where to choose it: in the app on the other computer.
 */
export function WhereHobbotsRuns() {
  const navigate = useNavigate();
  const [pick, setPick] = useState<WherePick>("here");
  const other = pick === "other";
  return (
    <WhereLayout
      footer={
        <WhereFooter
          blocked={other}
          onBack={() => void navigate({ to: "/welcome" })}
          onContinue={() => {
            if (!other) void navigate({ to: "/setup/providers" });
          }}
        />
      }
    >
      <WhereChoices value={pick} onPick={setPick} />
      {other && (
        <p role="status" className="m-0 animate-hb-in text-ui leading-normal text-text-secondary">
          {copy.connect.onHub}
        </p>
      )}
    </WhereLayout>
  );
}
