import { formatCount } from "../../lib/format.ts";

/** User-facing copy for the sidebar (STD-I18N-001). */
export const messages = {
  label: "Sections",
  wordmark: "Hobbots",
  collapse: "Collapse",
  expand: "Expand",
  collapseLabel: "Collapse the sidebar",
  expandLabel: "Expand the sidebar",
  hobs: "Hobs",
  allHobs: "Hobs: open Your hobs",
  hobsLoadFailed: "Could not load your hobs.",
  summonLabel: "Summon a hob",
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
  /** A hob's tooltip while the sidebar is collapsed, such as "Ada · needs you". */
  hobTip: ({ name, state, unread }: { name: string; state: string; unread: boolean }) =>
    `${name} · ${state.toLowerCase()}${unread ? " · new messages" : ""}`,
  /** The marks before the open hob's chat, its camps and Make a camp. */
  glyph: { chat: "✦", camp: "⛺", add: "+", more: "⋯" },
  /** The dot on a chat under the open hob that has messages you have not read. */
  unreadThread: "New messages",
  /** Under the open hob's first camps, to list the rest. */
  moreCamps: ({ count }: { count: number }) => `Show ${formatCount(count)} more`,
  fewerCamps: "Show fewer",
};
