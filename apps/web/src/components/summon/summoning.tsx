import type { Agent } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";

const copy = messages.summoning;

/** Where each spark rises, in percent of the circle, and when. */
const SPARKS = [
  [18, 70, 0],
  [78, 60, 200],
  [30, 20, 450],
  [70, 18, 650],
  [50, 8, 900],
  [10, 40, 1100],
  [88, 35, 1300],
  [42, 80, 1500],
] as const;

/** How long the summoning plays before the hob is shown, when motion is on. */
export const SUMMONING_MS = 2600;

type SpriteHob = Pick<Agent, "lookSeed" | "lookColor"> & Partial<Pick<Agent, "hat" | "tool">>;

/**
 * The summoning circle: a ring of light opens on the ground, the hob appears in it from the hat
 * down, a row at a time, and sparks rise around it. It is decorative; say what happens in words
 * beside it. Reduce motion stops every animation, so the hob simply stands in the ring.
 */
export function SummoningCircle({ hob, size, className }: { hob: SpriteHob; size: number; className?: string }) {
  return (
    <span aria-hidden className={cn("relative grid place-items-end justify-center", className)}>
      <span className="absolute inset-x-[8%] bottom-0 h-[24%] animate-hb-ring rounded-[50%] border-3 border-moonlight shadow-[0_0_24px_var(--color-moonlight),inset_0_0_18px_var(--color-moonlight)]" />
      <span className="absolute inset-x-[20%] top-[4%] bottom-[16%] animate-hb-glow rounded-[50%] bg-[radial-gradient(closest-side,var(--color-moonlight),transparent)] opacity-40" />
      {SPARKS.map(([x, y, delay]) => (
        <span
          key={`${x}-${y}`}
          className="absolute animate-hb-sparkle text-sm text-lantern"
          style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${delay}ms` }}
        >
          ✦
        </span>
      ))}
      <span className="relative mb-[8%] animate-hb-reveal">
        <HobSprite hob={hob} size={size} />
      </span>
    </span>
  );
}

/** Summon's summoning screen, while the hub makes the hob and the circle plays. */
export function Summoning({ hob, name }: { hob: SpriteHob; name: string }) {
  return (
    <div role="status" className="mx-auto flex max-w-[640px] flex-col items-center gap-5 px-10 py-[72px] text-center">
      <SummoningCircle hob={hob} size={140} className="size-60" />
      <strong className="max-w-full font-heading text-[22px] leading-7 font-(--heading-weight) break-words">
        {copy.line({ name })}
      </strong>
      <span className="text-text-secondary">{copy.note}</span>
    </div>
  );
}
