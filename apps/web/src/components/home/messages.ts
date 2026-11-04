import { formatCount, formatList, plural } from "../../lib/format.ts";

/** How many hobs a summary sentence names before it counts the rest. */
const NAMED = 3;

/** Up to three names, then a count of the rest: "Ada, Pip, Quill and 2 more". */
const someNames = (names: ReadonlyArray<string>): string =>
  names.length > NAMED
    ? formatList([...names.slice(0, NAMED), `${formatCount(names.length - NAMED)} more`])
    : formatList(names);

/** Copy for Home's summary, Needs you, Pick up where you left off and plan line (STD-I18N-001). */
export const messages = {
  summary: {
    none: "No hobs yet.",
    count: ({ count }: { count: number }) => plural(count, { one: "1 hob.", other: `${formatCount(count)} hobs.` }),
    needs: ({ names }: { names: ReadonlyArray<string> }) =>
      names.length === 0
        ? "Nothing needs you."
        : `${someNames(names)} ${plural(names.length, { one: "needs", other: "need" })} you.`,
    working: ({ names }: { names: ReadonlyArray<string> }) =>
      `${someNames(names)} ${plural(names.length, { one: "is", other: "are" })} working.`,
  },
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
