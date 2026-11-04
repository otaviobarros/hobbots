/** User-facing copy for a hob's archived threads (STD-I18N-001). */
const plural = new Intl.PluralRules("en");

export const messages = {
  entry: "Archived",
  entryLabel: ({ count }: { count: number }) =>
    plural.select(count) === "one" ? "Archived, 1 thread" : `Archived, ${count} threads`,
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
  backToArchived: "‹ Back to the Archive",
  loadMessagesFailed: "Hobbots could not read this thread. Try again.",
  loadingMessages: "Loading messages…",
  editHob: "Edit hob",
  chat: "Chat",
  lookingUp: "Opening the thread…",
  lookupFailed: "Hobbots could not tell whether this thread is archived. Try again in a moment.",
};
