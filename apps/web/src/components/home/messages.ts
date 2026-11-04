import { formatCount, plural } from "../../lib/format.ts";

/** Copy for Home's Needs you, Pick up where you left off and plan line (STD-I18N-001). */
export const messages = {
  plan: {
    title: "Claude Code plan",
    notReported: "Its limits show here once Claude Code reports them.",
    usage: "Usage",
  },
  needsYou: {
    title: "Needs you",
    openInbox: "Open Inbox",
    clear: "All clear",
    clearLine: "Nothing needs you. Your hobs will ask here first when something does.",
    history: "See history",
  },
  pickUp: {
    title: "Pick up where you left off",
    yourHobs: "Your hobs",
    empty: "Nothing to pick up yet. Your chats and quests show here once you start them.",
    writing: "writing a reply…",
    thinking: "thinking…",
    leads: ({ lead }: { lead: string }) => `${lead} leads it`,
    progress: ({ done, total }: { done: number; total: number }) =>
      `${formatCount(done)} of ${formatCount(total)} done`,
    needs: ({ count }: { count: number }) =>
      plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
  },
} as const;
