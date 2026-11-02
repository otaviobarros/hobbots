import { formatCount, formatList } from "../../lib/format.ts";
import type { UnavailableReason, WorkbenchTab } from "./workbench-model.ts";

/** Copy for the Workbench: one Task's full view (ADR 023, STD-I18N-001). */
export const messages = {
  label: ({ title }: { title: string }) => `Workbench for ${title}`,
  backToChat: "Back to chat",
  backToTask: "Back to the task",
  open: "Open in Workbench",
  openTask: ({ title }: { title: string }) => `Open ${title} in Workbench`,
  notFound: "This task is no longer on this hub.",
  loading: "Reading this task…",
  askedBy: ({ chain }: { chain: ReadonlyArray<string> }) => `asked by ${chain.join(" → ")}`,
  you: "You",
  owner: ({ name }: { name: string }) => `Owner: ${name}`,
  inSandbox: "In the sandbox",
  unsandboxed: "Unsandboxed",
  sandboxNotReady: "Needs the sandbox",
  sandboxHint: {
    on: "Commands run inside Hobbots' sandbox on the hub.",
    off: "Commands ran without Hobbots' sandbox on the hub.",
    unavailable: "The sandbox is not ready on this hub, so commands are blocked.",
  },
  attempts: "Attempts",
  attempt: ({ number }: { number: number }) => `Attempt ${formatCount(number)}`,
  noAttempt: "Not started yet",
  tabs: "Workbench views",
  tab: {
    summary: "Summary",
    changes: "Changes",
    files: "Files",
    terminal: "Terminal",
    browser: "Browser",
  } satisfies Record<WorkbenchTab, string>,
  state: {
    live: "Live",
    history: "History",
    unavailable: "Unavailable",
    "not-used": "Not used in this Task",
    "coming-soon": "Coming soon",
  },
  unavailable: {
    cleared: "Details were cleared after 30 days.",
    "too-many-files": "This folder is too big to track changes.",
    "too-slow": "This folder took too long to scan, so its changes are not tracked.",
    unreadable: "Hobbots could not read this folder, so its changes are not tracked.",
    unread: "Hobbots could not read this task's records.",
  } satisfies Record<UnavailableReason, string>,
  tryAgain: "Try again",
  notUsed: {
    changes: ({ name }: { name: string }) => `${name} did not change any files in this task.`,
    files: ({ name }: { name: string }) => `${name} did not make or touch any files in this task.`,
    terminal: ({ name }: { name: string }) => `${name} did not use the terminal in this task.`,
  },
  comingSoon: "Watching a hob use a browser comes in a later update.",
  names: (names: ReadonlyArray<string>) => formatList(names),
  chat: {
    open: ({ name }: { name: string }) => `Talk to ${name}`,
    hide: "Hide the chat",
    label: ({ title }: { title: string }) => `Talk about ${title}`,
    heading: ({ name }: { name: string }) => `Talk to ${name}`,
    about: ({ title }: { title: string }) => `About “${title}”`,
    close: "Close the chat",
    notes: "Your notes on this task",
    empty: ({ name }: { name: string }) => `Nothing sent about this task yet. ${name} reads what you send here.`,
    hintOwner: ({ name }: { name: string }) => `Goes to ${name} as a note on this task.`,
    hintLead: ({ lead, owner }: { lead: string; owner: string }) =>
      `Goes to ${lead}, who leads this work and passes it on to ${owner}.`,
    // Each nudge is a note sent with one tap. The set is copy, not a decision (ADR 023).
    nudges: ["Looks good", "Explain what you did", "Keep going"],
  },
};
