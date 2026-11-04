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

/** A chevron that points up while the dock is folded and down once it is open. */
export function DockChevron({ open }: { open: boolean }) {
  return <Icon>{open ? <path d="m4 6 4 4 4-4" /> : <path d="m4 10 4-4 4 4" />}</Icon>;
}

/** Expand: two corners pulled apart, or pushed together once the dock is as tall as it goes. */
export function ExpandIcon({ expanded }: { expanded: boolean }) {
  return <Icon>{expanded ? <path d="M6 2v4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 10v4h-4" />}</Icon>;
}
