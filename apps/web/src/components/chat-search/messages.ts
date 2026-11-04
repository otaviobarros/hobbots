import { formatCount, plural } from "../../lib/format.ts";

/** User-facing copy for searching this chat from its header (STD-I18N-001). */
export const messages = {
  open: "Search this chat",
  label: "Search this chat",
  close: "Close search",
  clear: "Clear the search",
  matches: "Matches in this chat",
  count: ({ count }: { count: number }) => plural(count, { one: "1 message", other: `${formatCount(count)} messages` }),
  nothing: ({ query }: { query: string }) => `Nothing in this chat says “${query}”.`,
  everywhere: ({ name }: { name: string }) => `Search all of ${name}'s chats`,
  you: "You",
  hit: ({ who, when }: { who: string; when: string }) => `${who} · ${when}`,
} as const;
