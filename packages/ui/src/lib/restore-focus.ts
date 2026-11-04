import { useEffect, useState } from "react";

/** What has focus right now, unless that is only the page itself. */
export const focusedElement = () =>
  document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;

/**
 * Moves focus to an element that is not a control, such as a heading or a landmark, by letting the
 * script focus it. It stays out of the Tab order.
 */
export const focusElement = (element: HTMLElement, options?: FocusOptions) => {
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus(options);
};

/** Where focus goes back to: what had it when the layer opened, or the page's main landmark if that is gone. */
const restoreFocus = (before: HTMLElement | null) => {
  if (before?.isConnected) {
    before.focus();
    return;
  }
  const main = document.querySelector<HTMLElement>("main");
  if (main !== null) focusElement(main);
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

/**
 * Focus for a layer that covers part of the page without being a dialog, such as the Workbench over
 * the chat. It remembers what had focus while the layer renders, before the layer takes it. When the
 * layer goes and its focus went with it, focus goes back there, or to the main landmark if that is
 * gone too. Focus that moved elsewhere on the way out, such as to a link in the sidebar, stays put.
 */
export const useReturnFocus = () => {
  const [before] = useState(focusedElement);
  useEffect(
    () => () => {
      if (focusedElement() === null) restoreFocus(before);
    },
    [before],
  );
};
