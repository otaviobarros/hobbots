/** User-facing copy for a hob's archived threads (STD-I18N-001). */
const plural = new Intl.PluralRules("en");

export const messages = {
  entry: "Archived",
  entryLabel: ({ count }: { count: number }) =>
    plural.select(count) === "one" ? "Archived, 1 thread" : `Archived, ${count} threads`,
  title: "Archived threads",
  threadCount: ({ count }: { count: number }) => (plural.select(count) === "one" ? "1 thread" : `${count} threads`),
  intro: ({ name }: { name: string }) =>
    `Threads you archived. They keep every message and still show up in search. Open one to read it, or restore it to ${name}'s list.`,
  rowDetail: ({ archived, last }: { archived: string; last: string }) => `archived ${archived} · last message ${last}`,
  justNow: "just now",
  hint: "To archive a thread, open its ⋯ menu or press ⌃⌘A.",
  empty: "No archived threads",
  emptyBody: ({ name }: { name: string }) =>
    `Archive a thread from its ⋯ menu to tidy ${name}'s list. It keeps every message and stays in search.`,
  backToThreads: ({ name }: { name: string }) => `‹ Back to ${name}'s threads`,
  loading: "Loading archived threads…",
  loadFailed: "Hobbots could not read the archived threads. Try again in a moment.",
  restore: "Restore",
  restoring: "Restoring…",
  restoreThread: ({ title }: { title: string }) => `Restore “${title}”`,
  tryAgain: "Try again",
  restoreFailed: ({ title }: { title: string }) =>
    `Couldn't restore “${title}”. Hobbots is reconnecting; try again in a moment.`,
  restoreRetired: ({ name, title }: { name: string; title: string }) =>
    `${name} is retired, so “${title}” stays archived.`,
  tag: "Archived",
  readOnly: "Archived · read-only",
  banner: ({ name, date }: { name: string; date: string }) =>
    `Archived on ${date}. Read-only: ${name} takes no new messages here until you restore it.`,
  draftKept: "Your unsent message is kept and comes back when you restore it.",
  footer: "Read-only until you restore it",
  backToArchived: "‹ Back to archived threads",
  loadMessagesFailed: "Hobbots could not read this thread. Try again.",
  loadingMessages: "Loading messages…",
  editHob: "Edit hob",
};
