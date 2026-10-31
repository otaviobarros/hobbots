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

  for (const swatch of section.querySelectorAll<HTMLInputElement>("[data-color]")) {
    swatch.addEventListener("change", () => {
      if (!swatch.checked) return;
      setMine({ color: swatch.value as HobColor });
      bounce();
    });
  }
};
