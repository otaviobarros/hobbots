import {
  CHIEF_BEACON,
  CHIEF_BEACON_PALETTE,
  CHIEF_FLAME,
  CHIEF_FLAME_PALETTE,
  CHIEF_PALETTE,
  CHIEF_STAFF,
  chiefBody,
  chiefFrame,
} from "@hobbots/art/chief";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";

/**
 * What the chief shows: `idle` stays still, `working` lights the lantern softly while any hob
 * works, and `needs-you` raises a blazing lantern with a "!" while a request waits in the Inbox.
 */
export type ChiefMood = "idle" | "working" | "needs-you";

const AHEAD = chiefBody(chiefFrame("ahead"));
const LEFT = chiefBody(chiefFrame("left"));
const RIGHT = chiefBody(chiefFrame("right"));
const BLINK = chiefBody(chiefFrame("blink"));

/**
 * The Hobbots mark. The chief looks around once when it appears and again whenever `looks`
 * changes (the rail bumps it on hover), then keeps still; only its lantern speaks for the hobs. Look frames are stacked over the still chief and
 * shown in their slice of `chief-*` in styles.css, so Reduce motion leaves the chief looking
 * ahead; the moods keep their colors, raised lantern and "!" without motion.
 */
export function ChiefMark({ size, mood = "idle", looks = 0 }: { size: number; mood?: ChiefMood; looks?: number }) {
  const cell = size / 20;
  const layer = (rows: ReadonlyArray<string>, palette: Readonly<Record<string, string>>, className?: string) => (
    <PixelArt rows={rows} palette={palette} size={size} className={cn("absolute inset-0", className)} />
  );
  return (
    <span className="relative block">
      {/* A new key replays the look-around. */}
      <span key={looks} className="chief-sway relative block" style={{ width: size, height: size }}>
        <PixelArt rows={AHEAD} palette={CHIEF_PALETTE} size={size} />
        {layer(LEFT, CHIEF_PALETTE, "chief-left opacity-0")}
        {layer(RIGHT, CHIEF_PALETTE, "chief-right opacity-0")}
        {layer(BLINK, CHIEF_PALETTE, "chief-blink opacity-0")}
        <span
          className="absolute inset-0"
          style={mood === "needs-you" ? { transform: `translateY(${-2 * cell}px)` } : undefined}
        >
          {layer(CHIEF_STAFF, CHIEF_PALETTE)}
          {mood === "working" && layer(CHIEF_FLAME, CHIEF_FLAME_PALETTE, "chief-glow")}
          {mood === "needs-you" && layer(CHIEF_BEACON, CHIEF_BEACON_PALETTE, "chief-beacon")}
        </span>
      </span>
      {mood === "needs-you" && (
        <span aria-hidden className="absolute -top-2 -right-1.5 font-pixel font-bold text-lantern text-sm">
          !
        </span>
      )}
    </span>
  );
}
