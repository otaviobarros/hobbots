/** Plays a one-shot animation class again, even when it is already set. */
export const replay = (element: Element, className: string) => {
  element.classList.remove(className);
  element.getBoundingClientRect();
  element.classList.add(className);
};

/** Whether the visitor asked their system to reduce motion. */
export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
