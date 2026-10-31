import { getMine, MINE_CHIRP } from "./mine.ts";
import { say } from "./say.ts";

/** The visitor's hob walks into the section on screen and greets them the first time. */

const GREETINGS: Record<string, (name: string) => string> = {
  coming: (name) => `${name} here. Want the tour?`,
  everywhere: () => "macOS and Linux first!",
  open: () => "You can read all my code.",
};

const POKES = [(name: string) => `Hi! I’m ${name}.`, () => "Save my spot?", () => "I like it here."];

export const initCompanion = () => {
  const spots = [...document.querySelectorAll<HTMLElement>("[data-companion]")];
  if (spots.length === 0 || !("IntersectionObserver" in window)) return;
  const greeted = new Set<string>();
  let pokes = 0;
  for (const spot of spots) {
    const button = spot.querySelector("[data-companion-button]");
    button?.addEventListener("click", () => {
      say(spot, POKES[pokes % POKES.length]?.(getMine().name) ?? "Hi!", MINE_CHIRP);
      pokes += 1;
    });
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.id;
        const here = entry.target.querySelector<HTMLElement>("[data-companion]");
        if (!here?.hidden) continue;
        for (const spot of spots) spot.hidden = spot !== here;
        if (greeted.has(id)) continue;
        greeted.add(id);
        window.setTimeout(() => {
          if (!here.hidden) say(here, GREETINGS[id]?.(getMine().name) ?? "Hi!", MINE_CHIRP, 3200);
        }, 1300);
      }
    },
    { rootMargin: "-35% 0px -35% 0px" },
  );
  for (const spot of spots) {
    const section = spot.closest("section");
    if (section) observer.observe(section);
  }
};
