import type { ReactNode } from "react";

/** A 16 px line icon. Decorative: the button that holds it is named. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      {children}
    </svg>
  );
}

/** Fold: the side panel closing to its edge. */
export function FoldIcon() {
  return (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M10 2.5v11M5 6l2 2-2 2" />
    </Icon>
  );
}

/** Unfold: the side panel opening from its edge. */
export function UnfoldIcon() {
  return (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M10 2.5v11M7 6 5 8l2 2" />
    </Icon>
  );
}
