import type { Agent } from "@hobbots/domain";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useMemo } from "react";
import { hobLook } from "../art/look.ts";
import type { HobState } from "../lib/hob-state.ts";

export { type HobState, hobState, stateLabel, threadState } from "../lib/hob-state.ts";

const motion: Record<HobState, string> = {
  idle: "",
  thinking: "animate-hb-bob",
  working: "animate-hb-bob",
  waiting: "",
  "needs-you": "",
  asleep: "opacity-60",
  paused: "opacity-60",
  failed: "grayscale animate-hb-shake",
};

const marks: Partial<Record<HobState, { text: string; className: string }>> = {
  waiting: { text: "?", className: "text-lantern animate-hb-blink" },
  "needs-you": { text: "!", className: "text-lantern animate-hb-blink" },
  asleep: { text: "z", className: "text-secondary-text animate-hb-float" },
  paused: { text: "z", className: "text-secondary-text animate-hb-float" },
};

/**
 * A hob's seeded avatar, in its role's hat and tool, with its state motion. Wrap a parent in `hop-on-hover` to make it hop
 * on hover; `.sprite` is the element that hops.
 */
export function HobSprite({
  hob,
  size,
  state = "idle",
  className,
}: {
  /** A hob without a role hat or tool wears what its seed picks. */
  hob: Pick<Agent, "lookSeed" | "lookColor"> & Partial<Pick<Agent, "hat" | "tool">>;
  size: number;
  state?: HobState;
  className?: string;
}) {
  const look = useMemo(
    () => hobLook(hob.lookSeed, hob.lookColor, { hat: hob.hat, tool: hob.tool }),
    [hob.lookSeed, hob.lookColor, hob.hat, hob.tool],
  );
  const mark = marks[state];
  return (
    <span className={cn("relative inline-block shrink-0", className)}>
      <span className="sprite block">
        <PixelArt rows={look.rows} palette={look.palette} size={size} className={motion[state]} />
      </span>
      {mark && (
        <span
          aria-hidden
          className={cn(
            "absolute -top-2 -right-1.5 font-pixel font-bold",
            size >= 48 ? "text-lg" : "text-sm",
            mark.className,
          )}
        >
          {mark.text}
        </span>
      )}
    </span>
  );
}
