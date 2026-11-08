import { pick } from "./tour.ts";

/** The theme picker: each swatch shows Home in that theme. */
export const initThemes = () => {
  const section = document.querySelector<HTMLElement>("[data-themes]");
  if (!section) return;
  const buttons = [...section.querySelectorAll<HTMLButtonElement>("[data-theme-pick]")];
  const shots = [...section.querySelectorAll<HTMLElement>(".shot-in")];
  buttons.forEach((button, i) => {
    button.addEventListener("click", () => pick(shots, buttons, i));
  });
};
