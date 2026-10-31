/**
 * User-facing copy for the components in this folder, grouped by feature (STD-I18N-001). Copy moves
 * here from a component when that component next changes.
 */
export const messages = {
  models: {
    loading: "Asking Claude Code for its models",
    failed: "Hobbots could not get Claude Code's models.",
    retry: "Try again",
  },
  setup: {
    failed: "Hobbots could not read your setup.",
    retry: "Try again",
  },
  summon: {
    checkAgain: "Check again",
    checking: "Checking…",
  },
  home: {
    openChat: ({ name, role, state }: { name: string; role: string; state: string }) =>
      `Open chat with ${name}, ${role}, ${state}`,
    happeningNow: "Happening now",
    allQuiet: "All quiet. No hob is replying right now.",
  },
} as const;
