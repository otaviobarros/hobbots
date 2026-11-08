import { replay } from "./motion.ts";

const timers = new WeakMap<Element, number>();

/** Shows a hob's speech bubble for a moment, with a hop. */
export const say = (hob: Element, text: string, ms = 1900) => {
  const bubble = hob.querySelector<HTMLElement>("[data-bubble]");
  const hop = hob.querySelector("[data-hop]");
  if (hop) replay(hop, "fx-hop");
  if (!bubble) return;
  bubble.textContent = text;
  bubble.hidden = false;
  window.clearTimeout(timers.get(bubble));
  timers.set(
    bubble,
    window.setTimeout(() => {
      bubble.hidden = true;
    }, ms),
  );
};
