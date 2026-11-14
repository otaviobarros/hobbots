import { useSyncExternalStore } from "react";

/** The wide breakpoint (styles.css `--breakpoint-wide`): from here the sidebar shows its labels. */
const WIDE = "(min-width: 1100px)";

const subscribe = (changed: () => void) => {
  const query = globalThis.matchMedia?.(WIDE);
  query?.addEventListener("change", changed);
  return () => query?.removeEventListener("change", changed);
};

/** Whether the window is wide enough for the full sidebar; below it the sidebar is a rail of icons. */
export const useWide = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(WIDE).matches ?? true,
    () => true,
  );
