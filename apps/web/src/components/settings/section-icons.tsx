import type { SettingsSection } from "./sections.ts";

/** Each section's line icon, drawn on a 16×16 grid in the current text color. */
const PATHS: Readonly<Record<SettingsSection | "overview", React.ReactNode>> = {
  overview: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  app: <path d="M13.5 2.5 7 9M5.5 9.5c-1.5 0-2.5 1-2.5 2.5 0 1-.5 1.5-1 1.5 1 .8 2.2 1 3.3 1 1.7 0 2.7-1.2 2.7-2.6z" />,
  safety: <path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z" />,
  connections: <path d="M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0zM8 12v2.5" />,
  devices: (
    <>
      <rect x="2" y="3" width="12" height="8" rx="1.5" />
      <path d="M1 13.5h14" />
    </>
  ),
  data: (
    <>
      <ellipse cx="8" cy="3.5" rx="5" ry="2" />
      <path d="M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.5M8 11.5v.1" />
    </>
  ),
};

/** A section's icon, decorative: the section's name always sits beside it. */
export function SectionIcon({ section, size = 16 }: { section: SettingsSection | "overview"; size?: number }) {
  return (
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
      {PATHS[section]}
    </svg>
  );
}
