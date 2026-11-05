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
    body: ", each hob saves notes with its own model.",
    note: "Change a hob's model on its profile.",
  },
  model: {
    title: "Memory model",
    intro:
      "For memory work no chat is running: summing up a chat after it ends, Check now and answering questions about memory.",
    provider: "Provider",
    model: "Model",
    effort: "Effort",
    providers: { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", none: "No AI" },
    geminiLater: "Gemini arrives in a later update.",
    models: { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus", mini: "GPT-5.4 mini", "gpt-5.5": "GPT-5.5" },
    efforts: { low: "Low", medium: "Medium", high: "High" },
    hints: {
      none: "Summaries are short lists of what happened, with no AI. Free, and nothing leaves the hub.",
      high: "High effort can be too slow for summaries: they may time out and fall back. Low is enough for this work.",
      claude: "Uses an Anthropic API key.",
      chatgpt: "Uses your ChatGPT sign-in through Codex.",
      small: "A small, fast model is enough for summaries.",
      opus: "Opus is the most careful, and costs the most.",
    },
    needsKey: ({ provider }: { provider: string }) =>
      `Hobbots can't hand ${provider} a key yet, so memory writes summaries with no AI for now. Your choice is kept for when it can.`,
    applies: "A change restarts only the memory engine, never the app.",
    saveFailed: "Hobbots could not save this choice, so memory still runs with the one before.",
    retry: "Try again",
    keepBefore: "Keep the one before",
  },
  fallback: {
    title: "If it is not available",
    options: { plain: "Write simple summaries", other: ({ other }: { other: string }) => `Use ${other}` },
    note: "For example, when a plan runs out for the week. Nothing is lost either way: a summary written without AI can be improved later.",
  },
  tasks: {
    show: "Choose a model per task…",
    hide: "Hide models per task",
    rows: {
      summaries: { title: "Summing up a chat", detail: "After a chat ends, or when a hob is gone" },
      check: { title: "Check now", detail: "Pages that disagree or look out of date" },
      answers: { title: "Answering questions about memory", detail: "When you ask Memory a question in plain words" },
    },
    same: "Same",
    none: "No AI",
    pickFirst: "Pick a provider first.",
    note: "Effort is shared by every task. Searching and saving never need a model.",
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
    needsKey: "Memory writes summaries with no AI until Hobbots can hand its model a key.",
    calls: ({ calls, tokens }: { calls: string; tokens: string }) => `${calls} · ${tokens} since memory last started`,
    callCount: { one: "1 call", other: (count: string) => `${count} calls` },
    tokens: ({ count }: { count: string }) => `${count} tokens`,
    unknown: "Memory isn't answering right now.",
    open: "Choose the memory model",
  },
};
