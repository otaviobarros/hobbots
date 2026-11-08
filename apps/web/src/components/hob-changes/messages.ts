/** The copy of a hob's History tab, the Changes log in Settings and the note on a Home tile (ADR 034). */
export const messages = {
  history: {
    heading: "History",
    intro: ({ name }: { name: string }) =>
      `Every change to ${name}, newest first, with who made it. Revert undoes the latest change as a new version made by you.`,
    empty: "No changes yet.",
    failed: "Hobbots could not read the changes.",
    retry: "Try again",
    waiting: "Reading the changes…",
  },
  log: {
    heading: "Changes",
    filters: "Filter the changes",
    hob: "Hob",
    actor: "Made by",
    charm: "Charm",
    any: "Any",
    you: "You",
    noCharm: "No Charm",
    none: "No changes match these filters.",
    clear: "Clear filters",
    more: ({ count }: { count: number }) => `Showing the newest ${count} changes.`,
  },
  row: {
    version: ({ version }: { version: number }) => `Version ${version}`,
    summoned: "Summoned",
    paused: "Paused",
    woke: "Woke up",
    retired: "Retired",
    broughtBack: "Brought back",
    byYou: "By you",
    byHob: ({ hob }: { hob: string }) => `By ${hob}`,
    byProposal: ({ hob }: { hob: string }) => `By you, proposed by ${hob}`,
    viaCharm: ({ charm }: { charm: string }) => `Through ${charm}`,
    openTask: "Open the request",
    openChat: "Open the chat turn",
    openHob: ({ hob }: { hob: string }) => `Open ${hob}'s profile`,
    revert: "Revert",
    reverting: "Reverting…",
    revertNote: ({ version }: { version: number }) =>
      `Restores version ${version} as a new version made by you. Replies already running finish the old way.`,
    revertFailed: "Hobbots could not revert this change.",
    notLatest: "Another change came after this one, so it can no longer be reverted.",
    unchanged: "Nothing in the settings changed.",
    showDiff: "Show what changed",
    hideDiff: "Hide what changed",
  },
  /** A hob that is no longer kept, or whose name is not read yet. */
  someHob: "another hob",
  fields: {
    name: "Name",
    role: "Role",
    goodAt: "Good at",
    look: "Look",
    voice: "Voice",
    length: "Reply length",
    brain: "Thinks with",
    instructions: "Instructions",
    visibleToHobs: "Seen by other hobs",
    ownFolders: "Its own folders",
    hiddenSharedFolders: "Hidden shared folders",
    charms: "Charms",
    rules: "Rules",
    signCommits: "Signs commits",
  },
  values: {
    none: "None",
    yes: "Yes",
    no: "No",
    shown: "Shown",
    hidden: "Hidden",
    defaultModel: "Default model",
    defaultEffort: "Default effort",
    fromSeed: "From the look",
    look: ({
      color,
      sigil,
      hat,
      tool,
      seed,
    }: {
      color: string;
      sigil: string;
      hat: string;
      tool: string;
      seed: number;
    }) => `${color} · ${sigil} sigil · Hat: ${hat} · Tool: ${tool} · Look ${seed}`,
    brain: ({ runtime, model, effort }: { runtime: string; model: string; effort: string }) =>
      `${runtime} · ${model} · ${effort}`,
    rule: ({ operation, answer }: { operation: string; answer: string }) => `${operation}: ${answer}`,
    answers: { allow: "Allow", ask: "Ask", deny: "Never" } as Record<string, string>,
    colors: {
      violet: "Violet",
      moss: "Moss",
      amber: "Amber",
      rose: "Rose",
      sky: "Sky",
      ember: "Ember",
    } as Record<string, string>,
    charms: { github: "GitHub", summoning: "Summoning" } as Record<string, string>,
  },
  profile: {
    summonedBy: ({ hob }: { hob: string }) => `Summoned by ${hob}`,
  },
  home: {
    changedBy: ({ hob }: { hob: string }) => `Changed by ${hob}`,
  },
};
