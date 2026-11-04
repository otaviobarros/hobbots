import { cn } from "@hobbots/ui/lib/utils";
import { CHIMNEYS, FIREFLIES, TWINKLES, WINDOW_GLOWS } from "../../art/village.ts";

/** The village's glow: lit windows that light up with the intro, chimney smoke, fireflies and twinkling stars. */
export function VillageLights({ playIntro }: { playIntro: boolean }) {
  return (
    <>
      {WINDOW_GLOWS.map((glow) => (
        <span
          key={`${glow.left}.${glow.top}`}
          aria-hidden
          className={cn(
            "absolute animate-hb-flicker rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--color-lantern-hover)_38%,transparent),color-mix(in_srgb,var(--color-lantern)_12%,transparent)_55%,transparent)]",
            playIntro && "animate-hb-light",
          )}
          style={{
            left: glow.left,
            top: glow.top,
            width: glow.size,
            height: glow.size,
            opacity: glow.size < 100 ? 0.5 : 1,
            animationDelay: `${glow.delay}s`,
          }}
        />
      ))}
      {CHIMNEYS.flatMap((chimney) =>
        chimney.puffs.map((delay) => (
          <span
            key={`${chimney.left}.${delay}`}
            aria-hidden
            className="absolute size-3 animate-hb-smoke bg-scene-smoke opacity-0"
            style={{ left: chimney.left, top: chimney.top, animationDelay: `${delay}s` }}
          />
        )),
      )}
      {FIREFLIES.map((fly) => (
        <span
          key={`${fly.left}.${fly.top}`}
          aria-hidden
          className="absolute size-1.5 animate-hb-firefly bg-lantern-hover shadow-[0_0_10px_var(--color-lantern)]"
          style={{ left: fly.left, top: fly.top, animationDelay: `${fly.delay}s` }}
        />
      ))}
      {TWINKLES.map((star) => (
        <span
          key={`${star.left}.${star.top}`}
          aria-hidden
          className="absolute size-2 animate-hb-twinkle bg-moonlight"
          style={{ left: star.left, top: star.top, animationDelay: `${star.delay}s` }}
        />
      ))}
    </>
  );
}
