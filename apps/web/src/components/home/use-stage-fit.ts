import { useLayoutEffect, useState } from "react";

/**
 * Whether `hob` stands on the stage's first line, the bottom one, wholly inside the stage, give or
 * take a rounding pixel. `floor` is where the first hob stands.
 */
const onStage = (hob: DOMRect, box: DOMRect, floor: number) =>
  Math.abs(hob.bottom - floor) <= 1 && hob.left >= box.left - 1 && hob.right <= box.right + 1 && hob.top >= box.top - 1;

/**
 * How many of the stage's hobs fit in it, counted from the first. The stage wraps the hobs that do
 * not fit onto lines above the first, so this counts its children until one leaves the first line.
 * Measured before paint, and again whenever the stage or a hob changes size, as the window resizes
 * or a bubble appears. `count` is the number of hobs on the stage, so a new crew is measured again.
 */
export const useStageFit = (stage: HTMLElement | null, count: number): number => {
  const [fit, setFit] = useState(count);
  useLayoutEffect(() => {
    if (stage == null || count === 0) return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      const hobs = [...stage.children].map((hob) => hob.getBoundingClientRect());
      const floor = hobs[0]?.bottom ?? box.bottom;
      const outside = hobs.findIndex((hob) => !onStage(hob, box, floor));
      setFit(outside === -1 ? hobs.length : outside);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    for (const hob of stage.children) observer.observe(hob);
    return () => observer.disconnect();
  }, [stage, count]);
  return Math.min(fit, count);
};
