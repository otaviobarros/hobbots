import type { Slide } from "../data/copy.ts";
import { reducedMotion } from "./motion.ts";

/** Pixels a finger has to move sideways before a swipe changes the screen. */
const SWIPE = 40;

/** Shows one screenshot of a group and hides the others, from assistive technology too. */
export const pick = (shots: ReadonlyArray<HTMLElement>, buttons: ReadonlyArray<HTMLElement>, index: number) => {
  shots.forEach((shot, i) => {
    shot.classList.toggle("on", i === index);
    shot.toggleAttribute("aria-hidden", i !== index);
    if (i === index) shot.setAttribute("loading", "eager");
  });
  buttons.forEach((button, i) => {
    button.setAttribute("aria-pressed", String(i === index));
  });
};

/**
 * The tour of the app: a tab per screen, each shown for five seconds while the tour plays. The bar under the
 * shown tab fills, and the next screen comes when it is full, so hovering, which pauses the bar, pauses the tour.
 * Picking a tab, swiping or Reduce motion stops it.
 */
export const initTour = () => {
  const tour = document.querySelector<HTMLElement>("[data-tour]");
  const data = tour?.querySelector("[data-tour-slides]")?.textContent;
  if (!tour || !data) return;
  const slides: ReadonlyArray<Slide> = JSON.parse(data);
  const tabs = [...tour.querySelectorAll<HTMLButtonElement>("[data-tour-tab]")];
  const frame = tour.querySelector<HTMLElement>("[data-tour-frame]");
  const shots = [...(frame?.querySelectorAll<HTMLElement>(".shot-in") ?? [])];
  const play = tour.querySelector<HTMLButtonElement>("[data-tour-play]");
  const name = tour.querySelector("[data-tour-name]");
  const title = tour.querySelector("[data-tour-title]");
  const body = tour.querySelector("[data-tour-body]");
  let current = 0;

  const show = (index: number) => {
    current = (index + slides.length) % slides.length;
    const slide = slides[current];
    pick(shots, tabs, current);
    if (slide && name && title && body) {
      name.textContent = slide.name;
      title.textContent = slide.title;
      body.textContent = slide.body;
    }
  };

  const setPlaying = (playing: boolean) => {
    tour.toggleAttribute("data-playing", playing);
    if (!play) return;
    play.textContent = playing ? "Pause the tour" : "Play the tour";
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      setPlaying(false);
      show(i);
    });
    tab.querySelector(".fill")?.addEventListener("animationend", () => show(current + 1));
  });
  play?.addEventListener("click", () => setPlaying(!tour.hasAttribute("data-playing")));

  // Hovering the screens, or focus on a tab, holds the bar, and with it the tour. Focus on the Play button holds
  // nothing, so pressing Play starts the tour at once.
  const hover = tour.querySelector(".tour");
  let hovered = false;
  let focused = false;
  const hold = () => tour.toggleAttribute("data-held", hovered || focused);
  hover?.addEventListener("mouseenter", () => {
    hovered = true;
    hold();
  });
  hover?.addEventListener("mouseleave", () => {
    hovered = false;
    hold();
  });
  const onTab = (target: EventTarget | null) => target instanceof Element && target.closest("[data-tour-tab]") !== null;
  tour.addEventListener("focusin", (event) => {
    focused = onTab(event.target);
    hold();
  });
  tour.addEventListener("focusout", (event) => {
    focused = onTab(event.relatedTarget);
    hold();
  });

  let startX: number | undefined;
  frame?.addEventListener("touchstart", (event) => {
    startX = event.touches[0]?.clientX;
  });
  frame?.addEventListener("touchend", (event) => {
    const endX = event.changedTouches[0]?.clientX;
    if (startX === undefined || endX === undefined || Math.abs(endX - startX) < SWIPE) return;
    setPlaying(false);
    show(current + (endX < startX ? 1 : -1));
  });

  // With Reduce motion nothing moves by itself, so there is no tour to play or pause.
  if (reducedMotion()) {
    if (play) play.hidden = true;
    return;
  }
  setPlaying(true);
};
