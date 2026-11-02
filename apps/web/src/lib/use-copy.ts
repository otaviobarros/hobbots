import { useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

/** How long "Copied" shows before the button reads "Copy" again. */
const COPIED_FOR_MS = 1500;

/**
 * Copies text to the clipboard and says how it went for a moment. The clipboard exists only in a
 * secure context, so a browser on another device over plain HTTP may not have it: that reads as failed.
 */
export const useCopy = (): readonly [CopyState, (text: string) => void] => {
  const [state, setState] = useState<CopyState>("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The reset timer is cleared when the button leaves the page.
  useEffect(() => () => clearTimeout(reset.current), []);

  const settle = (next: CopyState) => {
    setState(next);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setState("idle"), COPIED_FOR_MS);
  };
  const copy = (text: string) => {
    if (navigator.clipboard === undefined) return settle("failed");
    navigator.clipboard.writeText(text).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  };
  return [state, copy] as const;
};
