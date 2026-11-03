/** User-facing copy for exports (STD-I18N-001, STD-I18N-002). */
export const messages = {
  heading: "Export",
  intro:
    "Your chats, Quests and what hobs made, as Markdown and JSON you can read without Hobbots. Every piece of text is redacted, your own messages included. An export cannot be restored; a backup is what brings a hub back.",
  what: "What to export",
  everything: "Everything",
  oneHob: "One hob",
  hob: "Hob",
  destination: "Save in",
  destinationHint: "A folder on the computer that runs your hub, outside every folder hobs work in.",
  export: "Export",
  exporting: "Exporting…",
  dialogTitle: {
    thread: ({ title }: { title: string }) => `Export “${title}”`,
    hob: ({ name }: { name: string }) => `Export ${name}`,
  },
  dialogIntro: {
    thread: "This thread and the Quests started in it, as Markdown and JSON you can read without Hobbots.",
    hob: ({ name }: { name: string }) =>
      `${name}'s threads, the Quests it led and the Tasks it worked on, as Markdown and JSON you can read without Hobbots. Other hobs' Tasks show only their titles and states.`,
  },
  redacted: "Every piece of text is redacted, your own messages included. Redaction is best effort.",
  close: "Close",
  menuThread: "Export thread…",
  menuHob: "Export hob…",
  saved: ({ folder }: { folder: string }) => `Saved to ${folder}`,
  held: { threads: "Threads", quests: "Quests", files: "Files copied" },
  notCopied: {
    one: "1 file is listed with why it was not copied.",
    other: ({ count }: { count: string }) => `${count} files are listed with why they were not copied.`,
  },
  failed: "Hobbots could not write the export. Nothing was left behind. Try again.",
  noHobs: "No hobs yet.",
} as const;
