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
    more: "More hobs",
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
    intro:
      "Retired hobs don't work or take new chats. Their chats stay here, read-only, and still show up in search. Bring one back anytime and it picks up with all its chats.",
    list: "Retired hobs",
    read: ({ name }: Named) => `Read ${name}'s chats`,
    tag: "Retired",
    bringBack: "Bring back",
    bringingBack: "Bringing back…",
    bringBackLabel: ({ name }: Named) => `Bring back ${name}`,
    retired: ({ day }: { day: string }) => `Retired ${day}`,
    retiredUnknown: "Retired",
    /** What a retired hob did, from the chat it worked on last. */
    lastDid: ({ title }: { title: string }) => `Last helped with “${title}”.`,
    kept: ({ count }: { count: number }) =>
      plural(count, { one: "1 chat kept", other: `${formatCount(count)} chats kept` }),
    loading: "Loading retired hobs…",
    loadFailed: "Hobbots could not read your retired hobs. Try again in a moment.",
    none: "No retired hobs.",
    noneBody: "When you retire a hob from its profile, it and its chats land here.",
  },
  toast: {
    region: "Archive notifications ({hotkey})",
    restored: ({ title, name }: Titled & Named) => `Restored “${title}” to ${name}'s chats.`,
    undo: "Undo",
    undoAlt: ({ title }: Titled) => `Undo restore of ${title}`,
    restoreFailed: ({ title }: Titled) =>
      `Couldn't restore “${title}”. Hobbots may be reconnecting; try again in a moment.`,
    undoFailed: ({ title }: Titled) =>
      `Couldn't archive “${title}” again. Hobbots may be reconnecting; try again in a moment.`,
    tryAgain: "Try again",
    tryAgainAlt: ({ title }: Titled) => `Try again for ${title}`,
    back: ({ name, chats }: Named & { chats: number }) =>
      chats === 0
        ? `${name} is back. It rests until you give it something to do.`
        : `${name} is back, with ${plural(chats, { one: "its chat", other: `all ${formatCount(chats)} chats` })}. It rests until you give it something to do.`,
    undoBackAlt: ({ name }: Named) => `Undo bringing back ${name}`,
    backFailed: ({ name }: Named) => `Couldn't bring back ${name}. Hobbots may be reconnecting; try again in a moment.`,
    retireFailed: ({ name }: Named) =>
      `Couldn't retire ${name} again. Hobbots may be reconnecting; try again in a moment.`,
  },
  read: {
    withHob: ({ name, day }: Named & { day: string }) => `with ${name} · Archived ${day}`,
    banner: ({ name, day }: Named & { day: string }) =>
      `Archived on ${day}. Read-only: ${name} takes no new messages here until you restore it.`,
    bar: "Read-only. Restore it to pick up where it left off.",
    restoreTo: ({ name }: Named) => `Restore to ${name}'s chats`,
    loading: "Loading this chat…",
    loadFailed: "Hobbots could not read this chat. Try again in a moment.",
    tryAgain: "Try again",
    notArchived: "This chat is no longer archived.",
    openIt: "Open it",
    missing: "This chat is not in the Archive.",
    backToArchive: "Back to the Archive",
  },
  retired: {
    page: ({ name }: Named) => `${name}, retired`,
    line: ({ role, day, kept }: { role: string; day: string | null; kept: string }) =>
      [role, day === null ? "retired" : `retired ${day}`, kept].join(" · "),
    note: ({ name }: Named) =>
      `${name} is retired, so these chats are read-only until you bring it back. They still show up in search.`,
    chats: ({ name }: Named) => `${name}'s chats`,
    open: ({ title }: Titled) => `Read ${title}`,
    readOnly: "Read-only",
    none: ({ name }: Named) => `${name} left no chats.`,
    chatNote: ({ name }: Named) => `${name} is retired, so this chat is read-only. It still shows up in search.`,
    bar: ({ name }: Named) => `Read-only while ${name} is retired. Bring it back to pick up here.`,
    notHere: "This hob is not in the Archive.",
    notTheirs: ({ name }: Named) => `This chat is not one of ${name}'s.`,
    loading: "Loading this hob…",
    loadFailed: "Hobbots could not read this hob's chats. Try again in a moment.",
  },
} as const;
