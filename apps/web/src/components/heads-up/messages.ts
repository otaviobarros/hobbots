import { formatCount } from "../../lib/format.ts";

interface Named {
  readonly name: string;
}

/** Copy for a Heads-up on a clash between tasks' claims (ADR 037, STD-I18N-001). */
export const messages = {
  /** The mark before the title; the title says it in words. */
  mark: "⇄",
  title: {
    path: ({ count }: { count: number }) => `Heads-up: ${formatCount(count)} tasks change the same files`,
    branch: ({ count }: { count: number }) => `Heads-up: ${formatCount(count)} tasks work on the same branch`,
  },
  side: ({ name, task, key }: { name: string; task: string; key: string }) => `${name}, ${task}: ${key}`,
  elsewhere: "in another chat or camp",
  spotted: ({ name, key }: Named & { key: string }) =>
    `Spotted by the hub when ${name} claimed ${key}. Neither task was stopped, and each lead was told.`,
  unread: "Couldn't check for clashes. Hobbots may be reconnecting.",
  retry: "Check again",
} as const;
