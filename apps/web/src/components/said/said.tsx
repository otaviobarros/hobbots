import type { ReactNode } from "react";

/**
 * Words a screen reader says between the parts of a name, which the eye gets from the layout. Put it
 * inside the text it follows: the browser joins it to that text, where `sr-only`, taken out of the
 * flow, reads as a part of its own with a space before each comma.
 */
export function Said({ children }: { children: ReactNode }) {
  return <span className="said">{children}</span>;
}
