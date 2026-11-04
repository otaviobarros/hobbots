import { cn } from "@hobbots/ui/lib/utils";
import { POTION_CORK } from "../../art/icons.ts";
import type { PlanLevel } from "../../lib/usage.ts";

// A plan's potion (docs/design/ui-ux.md, Usage): a bottle of `deep` glass with a `line-2` outline,
// so it reads on light cards too, filled with what is left of the window it shows. The liquid takes
// the meter's tone: mint, lantern when low, rose when used up. A plan that reported nothing is an
// empty bottle. The cork is the same wood in every theme, from the art in src/art.

const LIQUID: Record<PlanLevel, string> = { ok: "bg-mint", low: "bg-lantern", out: "bg-rose" };

/** How full the potion is and in what tone, or null for an empty bottle. */
export interface PotionFill {
  /** What is left of the window, 0 to 1. */
  readonly left: number;
  readonly level: PlanLevel;
}

const height = (fill: PotionFill) => `${Math.round(Math.min(1, Math.max(0, fill.left)) * 100)}%`;

/** The plan card's bottle: cork, neck, glass with a shine, and two bubbles that rise three times. */
export function PotionBottle({ fill }: { fill: PotionFill | null }) {
  return (
    <span aria-hidden className="flex flex-col items-center">
      <span className="h-2.5 w-5 rounded-t-[3px]" style={POTION_CORK} />
      <span className="box-border h-2.5 w-[26px] border-[3px] border-b-0 border-line-2 bg-[color-mix(in_srgb,var(--color-text-strong)_10%,var(--color-deep))]" />
      <span className="relative box-border h-24 w-[76px] overflow-hidden rounded-[26px_26px_20px_20px] border-[3px] border-line-2 bg-deep">
        {fill !== null && (
          <span
            data-slot="potion-liquid"
            data-tone={fill.level}
            className={cn(
              "absolute inset-x-0 bottom-0 transition-[height] duration-600",
              LIQUID[fill.level],
            )}
            style={{ height: height(fill) }}
          >
            <i className="absolute inset-x-0 top-0 h-1 bg-white/25" />
            <i className="absolute bottom-1.5 left-[22px] size-[5px] animate-hb-bubble rounded-full bg-white/45 motion-reduce:hidden" />
            <i className="absolute bottom-0.5 left-11 size-[5px] animate-hb-bubble rounded-full bg-white/45 [animation-delay:1.4s] motion-reduce:hidden" />
          </span>
        )}
        <span className="absolute top-3 left-2.5 h-7 w-[7px] rounded-[4px] bg-white/20" />
      </span>
    </span>
  );
}

/** A provider tile's small bottle: the glass and its liquid, nothing else. */
export function PotionVial({ fill }: { fill: PotionFill | null }) {
  return (
    <span
      aria-hidden
      className="relative box-border h-9 w-[26px] shrink-0 overflow-hidden rounded-[9px_9px_7px_7px] border-2 border-line-2 bg-deep"
    >
      {fill !== null && (
        <span className={cn("absolute inset-x-0 bottom-0", LIQUID[fill.level])} style={{ height: height(fill) }} />
      )}
    </span>
  );
}
