/** User-facing copy for the line a hob's save leaves under its reply (STD-I18N-001). */
export const messages = {
  label: ({ name }: { name: string }) => `What ${name} saved to memory`,
  saved: ({ name, kind, title }: { name: string; kind: string; title: string }) =>
    `Saved to ${name}'s memory · ${kind}: ${title}`,
  kept: ({ name, kind, title }: { name: string; kind: string; title: string }) =>
    `Kept for ${name}'s memory, saved once memory is back · ${kind}: ${title}`,
  undone: ({ name }: { name: string }) => `Undone. ${name}'s memory is back as it was.`,
  open: "Open",
  openLabel: ({ title }: { title: string }) => `Open ${title} in Memory`,
  undo: "Undo",
  undoLabel: ({ title }: { title: string }) => `Undo saving ${title}`,
  unread: ({ name }: { name: string }) =>
    `Hobbots could not read what ${name} saved to memory in this chat, so those lines are hidden for now.`,
  retry: "Try again",
  failed: {
    newer: ({ name }: { name: string }) =>
      `${name}'s memory changed after this, so Undo would lose that. Open it to change it.`,
    undone: "This was undone already.",
    offline: "Memory is not answering. Try again in a moment.",
    other: "Could not undo this. Try again.",
  },
};
