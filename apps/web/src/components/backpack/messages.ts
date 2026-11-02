import { formatCount, plural } from "../../lib/format.ts";
import type { WaitingState } from "./backpack-model.ts";

/** User-facing copy for what hobs are waiting on: their backpacks (ADR 019, STD-I18N-001). */
export const messages = {
  /** What an item is, in words, with who sent it where the item says. */
  what: {
    task: ({ title }: { title: string }) => `A new Task: "${title}"`,
    result: ({ name, title }: { name: string; title: string }) => `${name}'s result for "${title}"`,
    failure: ({ name, title }: { name: string; title: string }) => `Why ${name}'s "${title}" ended`,
    checkpoint: ({ summary }: { summary: string }) => `A report: ${summary}`,
    question: ({ name, text }: { name: string; text: string }) => `${name} asks: ${text}`,
    answer: ({ text }: { text: string }) => `The answer to its question: ${text}`,
    "hand-off": ({ label }: { label: string }) => `A hand-off: ${label}`,
    note: ({ text }: { text: string }) => `Your note: ${text}`,
    message: ({ name, text }: { name: string; text: string }) => `${name}'s message: ${text}`,
    "approval-outcome": "How an approval ended",
    deadline: "A deadline that passed",
  },
  /** Who owes a response, and since when. */
  awaiting: ({ name }: { name: string }) => `awaiting ${name}`,
  since: ({ since }: { since: string }) => `since ${since}`,
  state: {
    waiting: "Waiting",
    delivered: "Delivered",
    acknowledged: "Acknowledged",
    processing: "Reading",
    consumed: "Consumed",
    answered: "Answered",
    late: "Late",
    dismissed: "Dismissed",
    stuck: "Stuck",
  } satisfies Record<WaitingState, string>,
  /** Said for the state, to a screen reader and on hover. */
  stateHint: {
    waiting: "Waiting for a turn to carry it.",
    delivered: "Put into a turn, which has not started yet.",
    acknowledged: "The turn that carries it has started.",
    processing: "The turn that carries it is reading it now.",
    consumed: "Handled by the turn that carried it.",
    answered: "Answered.",
    late: "Its Task had already ended or moved on, so it started nothing.",
    dismissed: "Dismissed.",
    stuck: "It ran out of tries and waits for your choice.",
  } satisfies Record<WaitingState, string>,
  routine: ({ count }: { count: number }) =>
    plural(count, {
      one: `${formatCount(count)} progress update rides along the next turn`,
      other: `${formatCount(count)} progress updates ride along the next turn`,
    }),
  more: ({ count }: { count: number }) => plural(count, { one: "1 more", other: `${formatCount(count)} more` }),
  /** The hob panel. */
  hob: {
    label: ({ name }: { name: string }) => `What ${name} is waiting on`,
    list: "Backpack items",
    count: ({ count }: { count: number }) =>
      plural(count, { one: "1 in the backpack", other: `${formatCount(count)} in the backpack` }),
  },
  /** The Quest tab. */
  quest: {
    label: ({ title }: { title: string }) => `What hobs on ${title} are waiting on`,
    list: "Items waiting",
    heading: "Waiting on",
  },
  workspace: {
    label: "What every hob is waiting on",
    list: "Every hob's items",
    heading: ({ count }: { count: number }) =>
      plural(count, { one: "Every hob · 1 waiting", other: `Every hob · ${formatCount(count)} waiting` }),
    empty: "No hob is waiting on anything.",
    loading: "Reading what hobs are waiting on…",
    loadFailed: "Hobbots could not read what hobs are waiting on.",
    tryAgain: "Try again",
    unknown: "Every hob",
  },
} as const;
