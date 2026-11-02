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
    checkpoint: "Reading a report on its Task",
    question: "Answering a question",
    answer: "Reading the answer to its question",
    "hand-off": "Taking a hand-off",
    message: "Reading a message",
    "approval-outcome": "Hearing how an approval ended",
    deadline: "A deadline that passed",
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
  /** Before what the runtime last said, shown as it said it. */
  diagnostic: "The runtime last said:",
  next: { retry: "Next: retry it", reassign: "Next: reassign it", dismiss: "Next: dismiss it" },
  retry: "Retry",
  reassign: "Reassign",
  dismiss: "Dismiss",
  reassignHeld: "Reassign arrives once a Task can change owners.",
  openChat: "Open in the chat",
  failed: "Hobbots could not save that. The blocker is read again.",
  retired: ({ name }: { name: string }) => `${name} retired, so this cannot be retried. Dismiss it instead.`,
  section: "Stuck work",
  loading: "Reading stuck work…",
  loadFailed: "Hobbots could not read stuck work, so something may still need you.",
  count: ({ count }: { count: number }) =>
    plural(count, {
      one: `${formatCount(count)} piece of work is stuck`,
      other: `${formatCount(count)} pieces of work are stuck`,
    }),
} as const;
