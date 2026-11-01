/** User-facing copy for the standing rules in Inbox History and Settings › Permissions (STD-I18N-001). */
export const messages = {
  heading: "Standing rules",
  history: {
    title: "What hobs may do without asking",
    intro: "Each “Always” you gave stays until you remove it. Removing one makes the hob ask again next time.",
  },
  settings: {
    intro:
      "Every “Always” rule, for every hob. Each one lets one hob do one thing in one place without asking. Remove a rule and that hob asks again next time.",
  },
  empty: "No standing rules",
  emptyHint: "When you pick “Always for this site” on a request, the rule it saves shows here.",
  loading: "Reading the rules…",
  failed: "Hobbots could not read the standing rules.",
  retry: "Try again",
  unknownHob: "A hob",
  saved: ({ day }: { day: string }) => `Saved ${day}`,
  lastUsed: ({ day }: { day: string }) => `last used ${day}`,
  notUsed: "not used yet",
  request: "See the request",
  requestLabel: ({ rule }: { rule: string }) => `See the request that saved: ${rule}`,
  remove: "Remove rule",
  removeLabel: ({ rule }: { rule: string }) => `Remove rule: ${rule}`,
  confirm: {
    question: ({ name }: { name: string }) => `Remove this rule? Next time ${name} does this, ${name} asks you first.`,
    hostNote: ({ name }: { name: string }) => `${name}'s running replies stop too, so nothing keeps using this site.`,
    remove: "Remove",
    removing: "Removing…",
    keep: "Keep it",
  },
  removeFailed: "Hobbots could not remove this rule. Try again.",
} as const;
