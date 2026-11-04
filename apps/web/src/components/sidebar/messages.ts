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
    paused: "Paused",
    resting: "Resting",
  },
  /** A hob's accessible name, such as "Ada, needs you". */
  hob: ({ name, state }: { name: string; state: string }) => `${name}, ${state.toLowerCase()}`,
  /** A hob's tooltip while the sidebar is collapsed, such as "Ada · needs you". */
  hobTip: ({ name, state }: { name: string; state: string }) => `${name} · ${state.toLowerCase()}`,
};
