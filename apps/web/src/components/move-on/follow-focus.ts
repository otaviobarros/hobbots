import { focusedElement } from "@hobbots/ui/lib/restore-focus";

/**
 * Where focus goes once something you decided leaves with the control that had focus: the next
 * thing that waits on you, else a fallback that is always there. Each is looked up when focus moves,
 * so it names what is on the page then, and either can be `null` while it is not there yet.
 */
interface Landing {
  readonly next: () => HTMLElement | null;
  readonly fallback: () => HTMLElement | null;
}

/**
 * A surface's landing, read from the card or form the decision is made in when it is sent, while
 * that is still on the page: a lane finds itself from it, for one.
 */
export type FocusTargets = (from: HTMLElement) => Landing;

/** For a surface with nowhere of its own to send focus. */
export const NO_TARGETS: FocusTargets = () => ({ next: () => null, fallback: () => null });

/** How long focus is followed after a send: past it, a late change is no longer the user's step. */
const FOLLOW_MS = 30_000;

/** The first control inside an element that takes focus, such as a choice, a button or a box. */
export const firstControl = (within: Element | null | undefined): HTMLElement | null =>
  within?.querySelector<HTMLElement>(
    "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], summary",
  ) ?? null;

/**
 * Follows focus while something sent from `from` is on its way (#988, #995). Only a surface that
 * holds focus when it sends follows it. When focus falls to the page, because the control that had
 * it left or went disabled, it moves to `targets`: at once once `from` has left, else once the send
 * is done, so a send that fails never moves you. A failed send gives focus back to what had it.
 * Any focus the user places ends the follow, and so does the time limit. Returns a stop function.
 */
export const followFocus = (from: HTMLElement, targets: FocusTargets, sent: Promise<unknown>): (() => void) => {
  const origin = focusedElement();
  if (origin === null || !from.contains(origin)) return () => undefined;
  const landing = targets(from);
  let settled = false;
  let done = false;
  const land = () => {
    if (done || focusedElement() !== null || (from.isConnected && !settled)) return;
    const target = landing.next() ?? landing.fallback();
    if (target === null) return;
    stop();
    target.focus();
  };
  const observer = new MutationObserver(land);
  const timer = window.setTimeout(() => stop(), FOLLOW_MS);
  const stop = () => {
    done = true;
    observer.disconnect();
    document.removeEventListener("focusin", stop);
    window.clearTimeout(timer);
  };
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  document.addEventListener("focusin", stop);
  sent.then(
    () => {
      settled = true;
      land();
    },
    () => {
      if (done) return;
      stop();
      // The control re-enables once the send failed; it takes focus back, beside its error.
      requestAnimationFrame(() => {
        if (focusedElement() === null && origin.isConnected) origin.focus();
      });
    },
  );
  return stop;
};
