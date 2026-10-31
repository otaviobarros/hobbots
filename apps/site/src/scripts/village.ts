import { hush, say } from "./say.ts";

/** The three hobs in the hero say hi in turn when clicked. */
export const initVillage = () => {
  const hobs = [...document.querySelectorAll<HTMLButtonElement>("[data-hob]")];
  const village = hobs[0]?.closest(".hobs");
  for (const hob of hobs) {
    const lines: ReadonlyArray<string> = JSON.parse(hob.dataset.lines ?? "[]");
    const notes: ReadonlyArray<number> = JSON.parse(hob.dataset.chirp ?? "[]");
    let pokes = 0;
    hob.addEventListener("click", () => {
      if (village) hush(village);
      say(hob, lines[pokes % lines.length] ?? "Hi!", notes);
      pokes += 1;
    });
  }
};
