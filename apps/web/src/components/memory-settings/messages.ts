/** User-facing copy for memory in Settings and Usage (STD-I18N-001). */
export const messages = {
  card: {
    label: "Memory",
    states: { running: "Running", starting: "Starting", restarting: "Starting again", off: "Off" },
    kept: ({ pages, size }: { pages: string | null; size: string | null }) =>
      [
        pages === null ? "What your hobs remember" : `${pages} your hobs remember`,
        size === null ? ", kept as plain text files on the hub." : `, kept as plain text files on the hub (${size}).`,
      ].join(""),
    pages: { one: "1 page", other: (count: string) => `${count} pages` },
    off: {
      disabled: "Memory is turned off on this hub. Your hobs work without it.",
      missing: "This copy of Hobbots has no memory engine, so your hobs work without memory.",
      checksum: "The memory engine failed its check, so Hobbots did not start it. Your hobs work without memory.",
    },
    engine: ({ version }: { version: string }) => `Memory engine: ai-memory ${version}, bundled`,
    showFiles: "Show the files",
    opening: "Opening…",
    showFailed:
      "Hobbots could not open the memory files. There may be none yet: they appear once a hob saves something. Try again after that.",
    tryAgain: "Try again",
    failed: "Hobbots could not read your memory settings. Try again in a moment.",
  },
  chat: {
    title: "In a chat",
    body: ", a hob saves what it learns as it works, with no extra model call.",
    note: "Summaries after a chat use the hub's brain above.",
  },
  brain: {
    label: "The hub's brain",
    intro:
      "The one model Hobbots uses for its own work, outside any hob's turn: summing up a chat for memory now and, once camps arrive, writing a camp's brief, summing up a chapter, and judgment calls such as whether a chapter drifts into a topic of its own. It runs on a plan you already signed in to.",
    model: "Model",
    recommended: ({ model }: { model: string }) => `${model} (recommended)`,
    list: ({ label, choice }: { label: string; choice: string }) => `${label}: ${choice}`,
    smallest: "Its smallest model",
    none: "No AI",
    effort: {
      low: "Runs at low effort: this work needs no more.",
      other: ({ effort }: { effort: string }) =>
        `Runs at ${effort} effort, chosen before. Low is enough for this work, and faster.`,
      useLow: "Use low effort",
    },
  },
  model: {
    providers: { claude: "Claude", chatgpt: "ChatGPT", none: "No AI" },
    hints: {
      none: "Summaries are short lists of what happened, with no AI. Free, and nothing leaves the hub.",
      claude: "Uses your Claude Code sign-in.",
      chatgpt: "Uses your ChatGPT sign-in through Codex.",
      small: "A small, fast model is enough for this work.",
      bigger: "A bigger model is more careful, and uses more of your plan.",
    },
    noModels: "The models appear once the provider answers.",
    replaced: ({ chosen, model }: { chosen: string; model: string }) =>
      `${chosen} is no longer offered, so memory uses ${model} instead.`,
    taskReplaced: ({ task, chosen, model }: { task: string; chosen: string; model: string }) =>
      `${task}: ${chosen} is no longer offered, so it uses ${model} instead.`,
    notReady: "Until it is back, summaries follow your choice below.",
    limited: ({ provider }: { provider: string }) =>
      `Your ${provider} plan reached its limit. Until it refills, summaries follow your choice below.`,
    limitedUntil: ({ provider, until }: { provider: string; until: string }) =>
      `Your ${provider} plan reached its limit. Until it refills at ${until}, summaries follow your choice below.`,
    applies: "A change restarts only the memory engine, never the app.",
    saveFailed: "Hobbots could not save this choice, so memory still runs with the one before.",
    retry: "Try again",
    keepBefore: "Keep the one before",
  },
  fallback: {
    title: "If it is not available",
    options: { plain: "Write simple summaries", other: ({ other }: { other: string }) => `Use ${other}` },
    note: "For example, when a plan runs out for the week or a provider is signed out. Nothing is lost either way: a summary written without AI can be improved later, and a judgment falls back to its rule.",
  },
  tasks: {
    show: "Choose a model per task…",
    hide: "Hide models per task",
    rows: {
      summaries: { title: "Summing up a chat", detail: "After a chat ends, or when a hob is gone" },
      check: { title: "Check now", detail: "Pages that disagree or look out of date" },
      answers: { title: "Answering questions about memory", detail: "When you ask Memory a question in plain words" },
      brief: { title: "Writing a camp's brief", detail: "What a camp is for and where it stands" },
      chapters: { title: "Summing up a chapter", detail: "Once a chapter of a chat rests" },
      judgments: {
        title: "Judgment calls",
        detail: "Whether a chapter drifts into its own topic, or two quests clash",
      },
    },
    same: "Same",
    gone: ({ model }: { model: string }) => `${model} (no longer offered)`,
    none: "No AI",
    groups: { memory: "For memory", hub: "For chats and camps" },
    pickFirst: "Pick a provider first.",
    note: "Every task runs at the brain's effort. Searching and saving never need a model. The tasks for chats and camps start once camps arrive; with No AI, they will follow simple rules.",
  },
  shares: {
    label: "What hobs learn",
    intro: "Each hob keeps its own memory. These decide when what one hob learned reaches the others.",
    follows: ({ preset }: { preset: string }) => `Follows ${preset}. Pick another preset above to change it.`,
    rows: {
      project: {
        title: "A hob shares with a project",
        detail: "Careful and Balanced ask you. Trusting lets it through and shows it in Memory with Undo.",
      },
      everyone: {
        title: "A hob changes About you",
        detail: "Always asks. Only you decide what every hob reads.",
      },
    },
    ask: "Ask me",
    through: "Let it through",
    alwaysAsks: "Not available: About you always asks.",
  },
  usage: {
    label: "Memory",
    noAi: "No AI: memory makes no model calls.",
    unavailable: ({ provider, state }: { provider: string; state: string }) =>
      `${provider} is ${state}, so summaries follow your fallback for now.`,
    limited: "at its plan's limit",
    calls: ({ calls, tokens }: { calls: string; tokens: string }) => `${calls} · ${tokens} since memory last started`,
    hubCalls: ({ calls, tokens }: { calls: string; tokens: string }) =>
      `The hub's own judgments and summaries: ${calls} · ${tokens} since the hub started`,
    callCount: { one: "1 call", other: (count: string) => `${count} calls` },
    tokens: ({ count }: { count: string }) => `${count} tokens`,
    unknown: "Memory isn't answering right now.",
    open: "Choose the hub's brain",
  },
};
