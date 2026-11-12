import { useEffect, useRef, useState } from "react";

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
 * each time the layer opens, before Radix moves focus inside, and puts focus back there when it
 * closes. Radix alone would focus the trigger, and such a layer has none. The layer's component can
 * stay mounted while it is closed, as the work sheet does (#895), so what had focus is read when the
 * layer opens, never when it first renders.
 *
 * A layer that animates out gives focus back only once it has gone. If focus moved somewhere else on
 * the way out, such as to another popover, it stays there: taking it back would close that popover
 * the moment it opened.
 */
export const useRestoreFocus = ({
  onOpenAutoFocus,
  onCloseAutoFocus,
}: {
  onOpenAutoFocus?: ((event: Event) => void) | undefined;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}) => {
  const before = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      // Radix asks before it moves focus inside, so what has focus now is what opened the layer.
      before.current = focusedElement();
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      const layer = event.currentTarget instanceof Node ? event.currentTarget : null;
      const now = focusedElement();
      if (now === null || layer?.contains(now)) restoreFocus(before.current);
    },
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
