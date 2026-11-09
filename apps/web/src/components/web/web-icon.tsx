/** The line icons a step line and a sheet's eyebrow show, drawn on a 16×16 grid. */
export const WebIcon = ({ kind, size = 14 }: { kind: "search" | "page" | "globe"; size?: number }) => (
  <svg
    aria-hidden
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="flex-none"
  >
    {kind === "search" ? (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </>
    ) : kind === "page" ? (
      <>
        <path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" />
        <path d="M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" />
      </>
    ) : (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6s-.8 4.3-2.6 6c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z" />
      </>
    )}
  </svg>
);
