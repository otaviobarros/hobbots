import { formatCount, plural } from "../../lib/format.ts";

interface Named {
  readonly name: string;
}

interface Titled {
  readonly title: string;
}

/** User-facing copy for the Archive (STD-I18N-001). */
export const messages = {
  title: "Archive",
  crumbs: "Breadcrumb",
  yourHobs: "Your hobs",
  intro: "Archived chats keep every message and still show up in search. Restore one to put it back in its hob's list.",
  tabs: {
    label: "Archive",
    chats: "Archived chats",
    hobs: "Retired hobs",
  },
  scope: {
    label: "Whose chats",
    all: "All hobs",
  },
  search: {
    label: "Search archived chats",
    clear: "Clear the search",
  },
  chats: {
    list: "Archived chats",
    open: ({ title }: Titled) => `Read ${title}`,
    meta: ({ name, day }: Named & { day: string }) => `${name} · Archived ${day}`,
    restore: "Restore",
    restoring: "Restoring…",
    restoreLabel: ({ title }: Titled) => `Restore “${title}”`,
    restoreFailed: ({ title }: Titled) =>
      `Couldn't restore “${title}”. Hobbots may be reconnecting; try again in a moment.`,
    tryAgain: "Try again",
    showMore: ({ count }: { count: number }) => `Show ${formatCount(count)} more`,
    loading: "Loading archived chats…",
    loadFailed: "Hobbots could not read the archived chats. Try again in a moment.",
    none: "Nothing archived yet.",
    noneAll: "No archived chats.",
    noneFor: ({ name }: Named) => `${name} has no archived chats.`,
    noMatch: ({ query }: { query: string }) => `No archived chats mention “${query}”.`,
    howTo: ({ mac }: { mac: boolean }) =>
      `To archive a chat, open its ⋯ menu and pick Archive, or press ${mac ? "⌃⌘A" : "Ctrl+Alt+A"}. A chat with a reply running or an approval waiting can be archived once that's done.`,
  },
  hobs: {
    intro: "Retired hobs don't work or take new chats. Their chats stay here, read-only, and still show up in search.",
    list: "Retired hobs",
    read: ({ name }: Named) => `Read ${name}'s chats`,
    tag: "Retired",
    retired: ({ day }: { day: string }) => `Retired ${day}`,
    retiredUnknown: "Retired",
    kept: ({ count }: { count: number }) =>
      plural(count, { one: "1 chat kept", other: `${formatCount(count)} chats kept` }),
    loading: "Loading retired hobs…",
    loadFailed: "Hobbots could not read your retired hobs. Try again in a moment.",
    none: "No retired hobs.",
    noneBody: "When you retire a hob from its profile, it and its chats land here.",
  },
} as const;
