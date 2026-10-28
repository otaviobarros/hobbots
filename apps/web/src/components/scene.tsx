import { useMemo } from "react";

/** Twinkling pixel stars across the full width and the top `height` pixels. */
export function Stars({ count, height }: { count: number; height: number }) {
  // A fixed seed keeps the sky the same on every render.
  const stars = useMemo(() => {
    let a = 7;
    const next = () => {
      a = (a * 16807) % 2147483647;
      return a / 2147483647;
    };
    return Array.from({ length: count }, () => ({
      x: Math.round(next() * 1000) / 10,
      y: Math.round(next() * height),
      z: next() < 0.3 ? 3 : 2,
      d: (next() * 3).toFixed(1),
    }));
  }, [count, height]);

  return stars.map((s) => (
    <span
      key={`${s.x}.${s.y}`}
      aria-hidden
      className="absolute animate-hb-twinkle bg-star"
      style={{ left: `${s.x}%`, top: s.y, width: s.z, height: s.z, animationDelay: `${s.d}s` }}
    />
  ));
}
