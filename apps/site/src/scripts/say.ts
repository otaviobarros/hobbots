import { replay } from "./motion.ts";
import { chirp } from "./sound.ts";

const timers = new WeakMap<Element, number>();

/** Shows a hob's speech bubble for a moment, with a hop and a chirp. */
export const say = (hob: Element, text: string, notes: ReadonlyArray<number>, ms = 1900) => {
  const bubble = hob.querySelector<HTMLElement>("[data-bubble]");
  const hop = hob.querySelector("[data-hop]");
  if (hop) replay(hop, "fx-hop");
  chirp(notes);
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

/** Hides every bubble in a group, so only one hob talks at a time. */
export const hush = (scope: ParentNode) => {
  for (const bubble of scope.querySelectorAll<HTMLElement>("[data-bubble]")) bubble.hidden = true;
};
