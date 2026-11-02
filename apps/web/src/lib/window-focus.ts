import { focusManager } from "@tanstack/react-query";

type Target = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * Queries that refetch on focus follow the window's focus as well as its visibility. TanStack Query
 * listens only for the page becoming visible, and the desktop app's window stays visible while the
 * person works in their browser, so coming back to it would otherwise refetch nothing.
 */
export const followWindowFocus = (
  target: Target = window,
  visible: () => boolean = () => document.visibilityState === "visible",
) =>
  focusManager.setEventListener((setFocused) => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    const onVisibility = () => setFocused(visible());
    target.addEventListener("focus", onFocus);
    target.addEventListener("blur", onBlur);
    target.addEventListener("visibilitychange", onVisibility);
    return () => {
      target.removeEventListener("focus", onFocus);
      target.removeEventListener("blur", onBlur);
      target.removeEventListener("visibilitychange", onVisibility);
    };
  });
