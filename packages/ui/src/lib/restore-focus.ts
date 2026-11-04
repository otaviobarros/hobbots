import { useState } from "react";

/** What has focus right now, unless that is only the page itself. */
const focusedElement = () =>
  document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;

/** Where focus goes back to: what had it when the layer opened, or the page's main landmark if that is gone. */
const restoreFocus = (before: HTMLElement | null) => {
  if (before?.isConnected) {
    before.focus();
    return;
  }
  const main = document.querySelector<HTMLElement>("main");
  if (main === null) return;
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus();
};

/**
 * Focus for a modal layer the app may open by itself, with no trigger. It remembers what had focus
 * while the layer renders, before Radix moves focus inside, and returns an `onCloseAutoFocus` that
 * puts focus back there. Radix alone would focus the trigger, and such a layer has none.
 */
export const useRestoreFocus = (onCloseAutoFocus?: (event: Event) => void) => {
  const [before] = useState(focusedElement);
  return (event: Event) => {
    onCloseAutoFocus?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    restoreFocus(before);
  };
};
