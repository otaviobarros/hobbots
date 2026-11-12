import { formatCount, plural } from "../../lib/format.ts";

/** User-facing copy for blockers: work that ran out of tries or lost its hob (STD-I18N-001). */
export const messages = {
  label: ({ name, what }: { name: string; what: string }) => `${name}'s work is stuck: ${what}`,
  heading: "Stuck",
  title: ({ name }: { name: string }) => `${name} could not carry on`,
  what: {
    task: ({ title }: { title: string }) => `Starting "${title}"`,
    result: ({ title }: { title: string }) => `Reading the result of "${title}"`,
    failure: ({ title }: { title: string }) => `Reading why "${title}" ended`,
    checkpoint: "Reading a report on its task",
    question: "Answering a question",
    answer: "Reading the answer to its question",
    "hand-off": "Taking a hand-off",
    message: "Reading a message",
    "approval-outcome": "Hearing how an approval ended",
    deadline: "A deadline that passed",
    "skill-proposal": "Hearing how a skill it suggested ended",
    "hob-proposal": "Hearing how you decided its proposal",
    "claim-clash": "Reading about a clash with another task",
    progress: "Reading progress",
  },
  why: {
    "retries-exhausted": ({ count }: { count: number }) =>
      plural(count, {
        one: `It was tried ${formatCount(count)} time, and the turn ended early.`,
        other: `It was tried ${formatCount(count)} times, and every turn ended early.`,
      }),
    "recipient-retired": ({ name }: { name: string }) => `${name} retired, so nobody can take it.`,
  },
  /** How the last try ended, from the hub's code. */
  lastEnd: {
    "not-accepted": "The last try never started.",
    unavailable: "The last try found the hob or its chat no longer taking work.",
    stopped: "You stopped the last try.",
    interrupted: "The last try was cut off.",
    failed: "The last try failed.",
    limited: "The last try ran into the provider's usage limit.",
  },
  /** Before the error the last try recorded, shown as it was recorded. */
  diagnostic: "Details:",
  next: { retry: "Next: retry it", reassign: "Next: reassign it", dismiss: "Next: dismiss it" },
  /** The toast once a choice is sent from a card that then leaves (#988). */
  decided: {
    retry: ({ name }: { name: string }) => `Sent back to ${name} for another try.`,
    dismiss: ({ name }: { name: string }) => `Dismissed ${name}'s stuck work.`,
    reassign: ({ name }: { name: string }) => `Gave the task to ${name}.`,
  },
  retry: "Retry",
  /** Opens the hobs the stuck work's Task can go to, as the lane's menu lists them (#1087). */
  reassign: "Reassign…",
  reassignTo: ({ title }: { title: string }) => `Reassign “${title}” to`,
  reassigning: "Reassigning…",
  noOneElse: "No other hob can take this task.",
  readingHobs: "Reading your hobs…",
  hobsUnread: "Hobbots could not read your hobs.",
  /** The work's Task tree could not be read, so whether another hob can take it is unknown. */
  reassignUnread: "Hobbots could not read whether another hob can take this.",
  tryAgain: "Try again",
  dismiss: "Dismiss",
  openChat: "Open in the chat",
  failed: "Hobbots could not save that. The blocker is read again.",
  retired: ({ name }: { name: string }) => `${name} retired, so this cannot be retried. Dismiss it instead.`,
  loadFailed: "Hobbots could not read stuck work, so something may still need you.",
} as const;
