/** User-facing copy for archiving a thread (STD-I18N-001). */

interface Named {
  readonly name: string;
}

interface Titled {
  readonly title: string;
}

export const messages = {
  threadMenu: ({ title }: Titled) => `More for “${title}”`,
  headerMenu: "More for this thread",
  archive: "Archive thread",
  archiveShortcut: ({ mac }: { mac: boolean }) => (mac ? "⌃⌘A" : "Ctrl+Alt+A"),
  undoShortcut: ({ mac }: { mac: boolean }) => (mac ? "⌘Z" : "Ctrl+Z"),
  /** The disabled menu item's reason. */
  blocked: {
    "reply-running": ({ name }: Named) => `${name} is still replying. Archive it once the reply ends.`,
    "approval-pending": ({ name }: Named) => `${name} is waiting for your approval here. Answer it first.`,
  },
  /** The toast when the shortcut meets a thread that cannot be archived yet. */
  cantYet: {
    "reply-running": ({ name }: Named) => `Can't archive yet: ${name} is still replying here.`,
    "approval-pending": ({ name }: Named) => `Can't archive yet: ${name} is waiting for your approval.`,
  },
  showRequest: "Show request",
  showRequestAlt: "Show the request waiting for your approval",
  archived: ({ title }: Titled) => `Archived “${title}”.`,
  undo: "Undo",
  undoAlt: ({ title }: Titled) => `Undo archive of ${title}`,
  /** The hub refused after the menu opened; the row stepped back in. */
  refused: {
    "reply-running": ({ name, title }: Named & Titled) =>
      `${name} started replying in “${title}”, so it stays in the list.`,
    "approval-pending": ({ name, title }: Named & Titled) =>
      `${name} is waiting for your approval in “${title}”, so it stays in the list.`,
    "hob-retired": ({ name, title }: Named & Titled) => `${name} is retired, so “${title}” stays as it is.`,
  },
  archiveFailed: ({ title }: Titled) =>
    `Couldn't archive “${title}”. Hobbots may be reconnecting; try again in a moment.`,
  undoFailed: ({ title }: Titled) =>
    `Couldn't bring back “${title}”. Hobbots may be reconnecting; try again in a moment.`,
  tryAgain: "Try again",
  tryAgainAlt: ({ title }: Titled) => `Try again for ${title}`,
  notifications: "Notifications ({hotkey})",
};
