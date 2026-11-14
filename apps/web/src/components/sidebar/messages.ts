import { formatCount } from "../../lib/format.ts";

/** User-facing copy for the sidebar (STD-I18N-001). */
export const messages = {
  label: "Sections",
  /** The four places above the camps. */
  places: { home: "Home", forYou: "For you", usage: "Usage", settings: "Settings" },
  wordmark: "Hobbots",
  find: "Find or jump to",
  /** Read after For you's label when something waits there, so it reads "For you, 2 waiting on you". */
  waiting: ({ count }: { count: number }) => `, ${formatCount(count)} waiting on you`,
  /** The keys that open Find, as a Mac and other systems name them. */
  findKeys: ({ mac }: { mac: boolean }) => (mac ? "⌘K" : "Ctrl+K"),
  makeCamp: "Make a camp",
  camps: "Camps",
  directMessages: "Direct messages",
  hobsLoadFailed: "Could not load your hobs.",
  campsLoadFailed: "Could not load your camps.",
  noCamps: "No camps yet.",
  noHobs: "No hobs yet.",
  tryAgain: "Try again",
  /** Try again on the rail, where there is no room for its words. */
  retryMark: "↻",
  summonLabel: "Summon a hob",
  allHobs: "All your hobs",
  state: {
    "needs-you": "Needs you",
    working: "Working",
    waiting: "Waiting on a command",
    paused: "Paused",
    resting: "Resting",
  },
  /** A hob's accessible name, such as "Ada, needs you", and "new messages" when it wrote since you read. */
  hob: ({ name, state, unread }: { name: string; state: string; unread: boolean }) =>
    `${name}, ${state.toLowerCase()}${unread ? ", new messages" : ""}`,
  /** The tag on a camp a hob waits on you in. */
  needsYou: "Needs you",
  /** What a camp's row says beyond its name, read after it. */
  campNews: ({ unread, mentions, needs }: { unread: number; mentions: number; needs: boolean }) =>
    [
      needs ? "Needs you" : "",
      mentions > 0 ? "Mentions you" : "",
      unread > 0 ? `${formatCount(unread)} new ${unread === 1 ? "message" : "messages"}` : "",
    ]
      .filter((part) => part !== "")
      .join(", "),
  /** The mark on a camp with a mention of you you have not read. */
  mention: "@",
  /** Under the first camps, to list the rest. */
  moreCamps: ({ count }: { count: number }) => `Show ${formatCount(count)} more`,
  fewerCamps: "Show fewer",
  /** Who you are, at the foot of the sidebar. */
  youRole: "Owner · this hub",
  settings: "Settings",
};
