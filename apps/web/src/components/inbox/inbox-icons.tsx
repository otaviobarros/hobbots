import { cn } from "@hobbots/ui/lib/utils";

/** The 16 × 16 line icons the Inbox draws beside its words, in the color of the text they sit by. */
const PATHS = {
  /** A clock, before when a row expires or how long it waited. */
  clock: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.5V8l2.5 1.5",
  /** A speech bubble, for a chat: a thread outside a quest, and Open in the chat. */
  chat: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  /** A screen on a stand, for this hub's devices. */
  screen: "M2 3h12v8H2zM5.5 14h5M8 11v3",
  /** Two sheets, for Copy. */
  copy: "M5.5 5.5h8v8h-8zM3 10.5v-7a1 1 0 0 1 1-1h6.5",
} as const;

export type InboxIconName = keyof typeof PATHS;

export function InboxIcon({ name, className }: { name: InboxIconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
