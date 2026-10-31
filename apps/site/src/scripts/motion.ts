/** Plays a one-shot animation class again, even when it is already set. */
export const replay = (element: Element, className: string) => {
  element.classList.remove(className);
  element.getBoundingClientRect();
  element.classList.add(className);
};
