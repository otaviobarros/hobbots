import { formatCount } from "../../lib/format.ts";

/** User-facing copy for the Your hobs page (STD-I18N-001). */
export const messages = {
  title: "Your hobs",
  summary: ({ needs, working, resting }: { needs: number; working: number; resting: number }) =>
    `${formatCount(needs)} need you · ${formatCount(working)} working · ${formatCount(resting)} resting`,
  find: {
    label: "Find a hob",
    placeholder: "Find by name or role",
    clear: "Clear the search",
  },
  summon: "Summon a hob",
  summonCard: "Pick a role and it moves in, ready to help.",
  filters: {
    label: "Show",
    all: "All",
    needs: "Need you",
    working: "Working",
    resting: "Resting",
  },
  card: {
    open: ({ name, state }: { name: string; state: string }) => `${name}, ${state}`,
    resting: "Resting",
    arrived: "Just arrived",
    noChats: "No chats yet",
    lastChat: "Last chat",
  },
  none: {
    found: "No hob by that name or role.",
    foundHint: "Try another word, or summon one that does it.",
    needs: "No hob needs you right now.",
    working: "No hob is working right now.",
    resting: "Every hob is busy.",
  },
  retired: ({ count }: { count: number }) => `Retired hobs · ${formatCount(count)}`,
  retiredLabel: "Retired hobs ·",
  loadFailed: "Your hobs could not be loaded. Check the connection and try again.",
} as const;
