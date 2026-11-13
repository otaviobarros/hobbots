import type { QuestState } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";

interface Named {
  readonly name: string;
}

interface Counted {
  readonly count: number;
}

const updates = (count: number) => plural(count, { one: "1 update", other: `${formatCount(count)} updates` });

/** User-facing copy for catching up on a chat or camp (ADR 037, STD-I18N-001). */
export const messages = {
  /** The line where what you have not read starts, with when you last read. */
  newSince: ({ time }: { readonly time: string | null }) =>
    time === null ? "New since you left" : `New since you left · ${time}`,
  heading: "While you were away",
  byline: ({ name, count }: Named & Counted) => `${name} · ${updates(count)}`,
  replies: ({ count }: Counted) => plural(count, { one: "1 new reply", other: `${formatCount(count)} new replies` }),
  more: ({ count }: Counted) =>
    plural(count, { one: "And 1 more change", other: `And ${formatCount(count)} more changes` }),
  tag: {
    replies: "New",
    needsYou: "Needs you",
    ended: "Ready",
    decided: "Decided",
    changed: "Changed",
    made: "Made",
  },
  needsYou: ({ goal, count }: { readonly goal: string } & Counted) =>
    plural(count, { one: `${goal} waits on you`, other: `${goal}: ${formatCount(count)} things wait on you` }),
  ended: {
    active: ({ goal }: { readonly goal: string }) => goal,
    paused: ({ goal }: { readonly goal: string }) => `${goal} is paused`,
    completed: ({ goal }: { readonly goal: string }) => `${goal} is done`,
    failed: ({ goal }: { readonly goal: string }) => `${goal} failed`,
    cancelled: ({ goal }: { readonly goal: string }) => `${goal} was cancelled`,
    stopping: ({ goal }: { readonly goal: string }) => `${goal} is stopping at your request`,
    stopped: ({ goal }: { readonly goal: string }) => `${goal} was stopped at your request`,
  } satisfies Record<QuestState, (quest: { readonly goal: string }) => string>,
  crossedOut: ({ text }: { readonly text: string }) => `No longer holds: ${text}`,
  made: ({ title, version }: { readonly title: string; readonly version: number }) =>
    version > 1 ? `${title} · version ${formatCount(version)}` : title,
  jump: "Jump ↓",
  jumpTo: ({ text }: { readonly text: string }) => `Jump to ${text}`,
  fold: "Got it, fold this",
  readFailed: "Couldn't read what changed while you were away. The chat stays unread until it can.",
  skip: "Skip it and mark the chat read",
  caughtUp: ({ count }: Counted) => `Caught up · ${updates(count)} while you were away`,
};
