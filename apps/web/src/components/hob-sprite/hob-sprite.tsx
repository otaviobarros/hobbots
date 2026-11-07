import { HOB_COLORS, hobLook } from "@hobbots/art/look";
import type { Agent } from "@hobbots/domain";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import type { CSSProperties } from "react";
import type { HobState } from "../../lib/hob-state.ts";
import { SigilBadge } from "../roles/role-sigil.tsx";

export { type HobState, hobState, stateLabel, threadState } from "../../lib/hob-state.ts";

const motion: Record<HobState, string> = {
  idle: "",
  thinking: "animate-hb-bob",
  working: "animate-hb-bob",
  // Nothing is being written: the hob stands still while its command runs (#1056).
  "on-command": "",
  waiting: "",
  "needs-you": "",
  asleep: "opacity-60",
  paused: "opacity-60",
  failed: "grayscale animate-hb-shake",
};

const marks: Partial<Record<HobState, { text: string; className: string }>> = {
  waiting: { text: "?", className: "text-lantern animate-hb-blink" },
  "needs-you": { text: "!", className: "text-lantern animate-hb-blink" },
  asleep: { text: "z", className: "text-text-secondary animate-hb-float" },
  paused: { text: "z", className: "text-text-secondary animate-hb-float" },
};

/**
 * A hob's seeded avatar, in its role's hat and tool, with its state motion. With `badge`, its role's
 * sigil sits on the bottom-left corner. Wrap a parent in `hop-on-hover` to make it hop on hover;
 * `.sprite` is the element that hops, and the sigil stays put.
 */
export function HobSprite({
  hob,
  size,
  state = "idle",
  badge = false,
  className,
}: {
  /** A hob without a role hat or tool wears what its seed picks. */
  hob: Pick<Agent, "lookSeed" | "lookColor"> & Partial<Pick<Agent, "hat" | "tool" | "sigil">>;
  size: number;
  state?: HobState;
  /** Shows the role's sigil, which is decorative: say the role's title in words beside it. */
  badge?: boolean;
  className?: string;
}) {
  const look = hobLook(hob.lookSeed, hob.lookColor, { hat: hob.hat, tool: hob.tool });
  const mark = marks[state];
  return (
    <span className={cn("relative inline-block shrink-0", className)}>
      <span className="sprite block">
        <PixelArt rows={look.rows} palette={look.palette} size={size} className={motion[state]} />
      </span>
      {badge && hob.sigil && <SigilBadge sigil={hob.sigil} avatar={size} />}
      {mark && (
        <span
          aria-hidden
          className={cn(
            "absolute -top-2 -end-1.5 font-pixel font-bold",
            size >= 48 ? "text-title" : "text-ui",
            mark.className,
          )}
        >
          {mark.text}
        </span>
      )}
    </span>
  );
}

/** The tile sizes a hob sits on, with the sprite each holds: a work row, a reply, a header or Home row. */
const TILES = {
  sm: { className: "size-6", sprite: 18 },
  md: { className: "size-7.5", sprite: 21 },
  lg: { className: "size-hob-tile", sprite: 27 },
} as const;

/**
 * A hob on a tile tinted in its hat color: on a work row, beside its replies, and on the Workbench
 * header and Home's rows. Decorative: its name is always beside it.
 */
export function HobTile({
  hob,
  tile,
  state = "idle",
}: {
  hob: Pick<Agent, "lookSeed" | "lookColor"> & Partial<Pick<Agent, "hat" | "tool" | "sigil">>;
  tile: keyof typeof TILES;
  state?: HobState;
}) {
  const { className, sprite } = TILES[tile];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-tile bg-[color-mix(in_srgb,var(--hob)_30%,var(--color-card))]",
        className,
      )}
      style={{ "--hob": HOB_COLORS[hob.lookColor].hat } as CSSProperties}
    >
      <HobSprite hob={hob} size={sprite} state={state} />
    </span>
  );
}
