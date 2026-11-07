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
  card: {
    close: "Close",
    openPage: "Open page",
    profile: "Profile",
    backpack: "Backpack",
    backpackEmpty: "Nothing to deal with right now.",
    /** The backpack's list, for screen readers. */
    backpackList: ({ name }: { name: string }) => `What ${name} still has to deal with`,
  },
  /** A hob's accessible name, such as "Ada, needs you", and "new messages" when it wrote since you read. */
  hob: ({ name, state, unread }: { name: string; state: string; unread: boolean }) =>
    `${name}, ${state.toLowerCase()}${unread ? ", new messages" : ""}`,
  /** A hob's tooltip while the sidebar is collapsed, such as "Ada · needs you". */
  hobTip: ({ name, state, unread }: { name: string; state: string; unread: boolean }) =>
    `${name} · ${state.toLowerCase()}${unread ? " · new messages" : ""}`,
  /** The dot on a chat under the open hob that has messages you have not read. */
  unreadThread: "New messages",
};
