import type { HobColor } from "@hobbots/art/look";
import { getMine, MINE_CHIRP, NAMES, setMine } from "./mine.ts";
import { replay } from "./motion.ts";
import { say } from "./say.ts";

const LINES = ["New hat!", "Is this me?", "Ooh, I like it.", "Ta-da!", "Pick me!"];

const randomName = (other: string) => {
  let name = other;
  while (name === other) name = NAMES[Math.floor(Math.random() * NAMES.length)] ?? "Pip";
  return name;
};

/** Roll a hob: a new seed and name, a color from the six, and a hop each time. */
export const initRoll = () => {
  const section = document.querySelector<HTMLElement>("#roll");
  const roller = section?.querySelector<HTMLElement>(".roller");
  const hop = section?.querySelector<HTMLElement>("[data-roll-hop]");
  const poof = section?.querySelector<HTMLElement>("[data-poof]");
  if (!section || !roller || !hop || !poof) return;
  let rolls = 0;

  const bounce = () => replay(hop, "fx-hop");

  section.querySelector("[data-roll]")?.addEventListener("click", () => {
    setMine({ seed: Math.floor(Math.random() * 1_000_000), name: randomName(getMine().name) });
    replay(poof, "poof");
    bounce();
    const line = LINES[rolls % LINES.length] ?? "Ta-da!";
    rolls += 1;
    window.setTimeout(() => say(roller, line, MINE_CHIRP, 1600), 350);
  });

  section.querySelector("[data-rename]")?.addEventListener("click", () => {
    setMine({ name: randomName(getMine().name) });
    bounce();
  });

  const swatches = [...section.querySelectorAll<HTMLButtonElement>("[data-color]")];
  const pick = (swatch: HTMLButtonElement) => {
    for (const other of swatches) {
      const on = other === swatch;
      other.setAttribute("aria-checked", String(on));
      other.tabIndex = on ? 0 : -1;
    }
    setMine({ color: swatch.dataset.color as HobColor });
    bounce();
  };
  swatches.forEach((swatch, i) => {
    swatch.addEventListener("click", () => pick(swatch));
    // Arrow keys move the choice, as in any radio group.
    swatch.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = swatches[(i + step + swatches.length) % swatches.length];
      if (!next) return;
      next.focus();
      pick(next);
    });
  });
};
