import { formatCount, formatDay, plural } from "../../lib/format.ts";

/** User-facing copy for a hob's page (STD-I18N-001). */
export const messages = {
  page: ({ name }: { name: string }) => `${name}'s page`,
  crumbs: "Breadcrumb",
  yourHobs: "Your hobs",
  loading: "Loading this hob…",
  missing: "This hob is not here. It may have been retired.",
  tags: {
    needsYou: "Needs you",
    working: "Working",
    resting: "Resting",
    paused: "Paused",
    failed: "Had a problem",
  },
  stats: {
    chats: ({ count }: { count: number }) =>
      count === 0 ? "No chats yet" : plural(count, { one: "1 chat", other: `${formatCount(count)} chats` }),
    since: ({ date }: { date: string }) => `with you since ${formatDay(date)}`,
    line: ({ chats, since }: { chats: string; since: string }) => `${chats} · ${since}`,
  },
  doing: {
    writing: ({ title }: { title: string }) => `Writing “${title}”`,
    thinking: ({ title }: { title: string }) => `Thinking about “${title}”`,
    waiting: "Waiting on you",
    seeWhat: "See what it needs",
    paused: "Paused until you wake it",
    live: "Working",
  },
  newChat: "New chat",
  newChatWith: ({ name }: { name: string }) => `New chat with ${name}`,
  profile: "Profile",
  tabs: {
    label: ({ name }: { name: string }) => `${name}'s chats and history`,
    chats: "Chats",
    history: "History",
  },
  chats: {
    none: "No chats yet. Start one with New chat.",
    open: ({ title }: { title: string }) => `Open ${title}`,
    working: "Working",
  },
  history: {
    soon: "History is on its way",
    soonBody: ({ name }: { name: string }) => `It will list what ${name} did across all its chats, newest first.`,
  },
  aside: {
    label: ({ name }: { name: string }) => `About ${name}`,
    thinksWith: "Thinks with",
    change: "Change in Profile",
  },
  showNav: "Show hob list",
} as const;
