import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { CHIEF_FLAME, CHIEF_FLAME_PALETTE, CHIEF_PALETTE, chiefFrame } from "../art/chief.ts";

const AHEAD = chiefFrame("ahead");
const LEFT = chiefFrame("left");
const RIGHT = chiefFrame("right");
const BLINK = chiefFrame("blink");

/**
 * The Hobbots mark, alive: the chief glances left and right, leaning a step with each look,
 * blinks, and the lantern flickers. Each frame is stacked over the still chief and shown in its
 * slice of one loop (`chief-*` in styles.css), so Reduce motion leaves the chief looking ahead.
 * Wrap a parent in `hop-on-hover` to make it hop on hover.
 */
export function ChiefMark({ size }: { size: number }) {
  const frame = (rows: ReadonlyArray<string>, className: string) => (
    <PixelArt rows={rows} palette={CHIEF_PALETTE} size={size} className={`absolute inset-0 opacity-0 ${className}`} />
  );
  return (
    <span className="sprite block">
      <span className="chief-sway relative block" style={{ width: size, height: size }}>
        <PixelArt rows={AHEAD} palette={CHIEF_PALETTE} size={size} />
        {frame(LEFT, "chief-left")}
        {frame(RIGHT, "chief-right")}
        {frame(BLINK, "chief-blink")}
        <PixelArt
          rows={CHIEF_FLAME}
          palette={CHIEF_FLAME_PALETTE}
          size={size}
          className="absolute inset-0 animate-hb-flicker"
        />
      </span>
    </span>
  );
}
