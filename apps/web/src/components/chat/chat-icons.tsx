import type { ReactNode } from "react";

// The chat's line icons, 1.5 stroke with round caps: the header's back arrow and ⋯ menu, and the
// composer's Send.

const LineIcon = ({ children, size }: { children: ReactNode; size: "menu" | "danger" | "send" | "back" }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={
      size === "send" || size === "back"
        ? "size-4 flex-none"
        : size === "menu"
          ? "size-3.5 flex-none text-text-secondary"
          : "size-3.5 flex-none"
    }
  >
    {children}
  </svg>
);

/** A pencil, on Rename. */
export const RenameIcon = () => (
  <LineIcon size="menu">
    <path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />
  </LineIcon>
);

/** A pin, on Pin to the top and Unpin. */
export const PinMenuIcon = () => (
  <LineIcon size="menu">
    <path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6z" />
    <path d="M8 8.5V14" />
  </LineIcon>
);

/** A magnifier, on Search this chat. */
export const SearchMenuIcon = () => (
  <LineIcon size="menu">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </LineIcon>
);

/** A door, on the hob's page. */
export const DoorIcon = () => (
  <LineIcon size="menu">
    <path d="M3.5 14V3a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v11M2 14h12" />
    <circle cx="10" cy="8.5" r=".6" />
  </LineIcon>
);

/** Sliders, on Edit hob. */
export const SlidersIcon = () => (
  <LineIcon size="menu">
    <path d="M2.5 4.5h11M2.5 11.5h11" />
    <circle cx="5.5" cy="4.5" r="1.5" />
    <circle cx="10.5" cy="11.5" r="1.5" />
  </LineIcon>
);

/** A spark, on the brain the chat thinks with. */
export const SparkIcon = () => (
  <LineIcon size="menu">
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.5 1.5M10.5 10.5 12 12M12 4l-1.5 1.5M5.5 10.5 4 12" />
  </LineIcon>
);

/** A page going out, on Export. */
export const ExportIcon = () => (
  <LineIcon size="menu">
    <path d="M8 10V2.5M5 5.5l3-3 3 3" />
    <path d="M3 9.5V13h10V9.5" />
  </LineIcon>
);

/** A closed box, on Archive chat. */
export const ArchiveMenuIcon = () => (
  <LineIcon size="danger">
    <rect x="2" y="3" width="12" height="3" rx="1" />
    <path d="M3 6v7h10V6M6.5 9h3" />
  </LineIcon>
);

/** An arrow pointing back, at the start of the chat header: back to the hob's chats. */
export const BackIcon = () => (
  <LineIcon size="back">
    <path d="M13 8H3M7.5 3.5 3 8l4.5 4.5" />
  </LineIcon>
);

/** An arrow up, on the composer's Send. */
export const SendIcon = () => (
  <LineIcon size="send">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </LineIcon>
);
