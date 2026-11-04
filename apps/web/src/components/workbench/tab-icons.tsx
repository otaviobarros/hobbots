import type { ReactNode } from "react";
import type { WorkbenchTab } from "./workbench-model.ts";

// 16px line icons for the Workbench tabs: 1.5 stroke, round caps, in the tab's text color.
const paths: Readonly<Record<WorkbenchTab, ReactNode>> = {
  summary: (
    <>
      <path d="M3.5 2h6l3 3v9h-9z" />
      <path d="M6 8h4M6 11h4" />
    </>
  ),
  changes: <path d="M5 2.5v7M1.5 6h7M8 13.5h6.5" />,
  files: <path d="M2 4.5V12.5h12V6H8L6.5 4.5z" />,
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 6.5 6.5 8.5 4.5 10.5M8.5 10.5h3" />
    </>
  ),
  browser: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </>
  ),
};

/** A tab's icon. Its label always sits beside it, so the icon is hidden from assistive tech. */
export function TabIcon({ tab }: { tab: WorkbenchTab }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[15px] opacity-85"
    >
      {paths[tab]}
    </svg>
  );
}
