import { useEffect, useState } from "react";

/**
 * How far above the bottom of the sheet's column the chat's composer starts, so the sheet can stop
 * there and never cover what you type (#515). Follows the composer as it grows, and the column as the
 * window resizes; measured each time the sheet opens, and undefined until both are in the page.
 */
export const useComposerClearance = (host: HTMLElement | null, open: boolean): number | undefined => {
  const [clearance, setClearance] = useState<number>();
  useEffect(() => {
    const column = host?.parentElement;
    const composer = column?.querySelector<HTMLElement>("[data-composer]");
    if (!open || column == null || composer == null) return;
    const measure = () =>
      setClearance(Math.max(0, column.getBoundingClientRect().bottom - composer.getBoundingClientRect().top));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [host, open]);
  return clearance;
};
