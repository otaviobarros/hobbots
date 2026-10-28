import type { Agent } from "@hobbots/domain";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useMemo } from "react";
import { hobLook } from "../art/look.ts";

/** Sprite states from the design sprite sheet that the current build can show. */
export type HobState = "idle" | "thinking" | "working" | "waiting" | "needs-you" | "asleep" | "failed";

const motion: Record<HobState, string> = {
  idle: "",
  thinking: "animate-hb-bob",
  working: "animate-hb-bob",
  waiting: "",
  "needs-you": "",
  asleep: "opacity-60",
  failed: "grayscale animate-hb-shake",
};

const marks: Partial<Record<HobState, { text: string; className: string }>> = {
  waiting: { text: "?", className: "text-lantern animate-hb-blink" },
  "needs-you": { text: "!", className: "text-lantern animate-hb-blink" },
  asleep: { text: "z", className: "text-secondary-text animate-hb-float" },
};

/**
 * A hob's seeded avatar with its state motion. Wrap a parent in `hop-on-hover` to make it hop
 * on hover; `.sprite` is the element that hops.
 */
export function HobSprite({
  hob,
  size,
  state = "idle",
  className,
}: {
  hob: Pick<Agent, "lookSeed" | "lookColor">;
  size: number;
  state?: HobState;
  className?: string;
}) {
  const look = useMemo(() => hobLook(hob.lookSeed, hob.lookColor), [hob.lookSeed, hob.lookColor]);
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

/** Words for a state, for headers and screen readers. */
export const stateLabel: Record<HobState, string> = {
  idle: "ready",
  thinking: "thinking",
  working: "working",
  waiting: "waiting",
  "needs-you": "needs you",
  asleep: "asleep",
  failed: "had a problem",
};

/** A hob is working while any of its threads streams a reply. */
export const hobStateFrom = (
  threads: ReadonlyArray<{ readonly id: string }> | undefined,
  activity: Readonly<Record<string, "thinking" | "working">>,
): HobState => {
  const states = (threads ?? []).map((t) => activity[t.id]).filter((a) => a !== undefined);
  if (states.includes("working")) return "working";
  return states.length > 0 ? "thinking" : "idle";
};
